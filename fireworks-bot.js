// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const Database = require('better-sqlite3');

// env
const {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  MUTE_ROLE_ID,
  DAILY_LIMIT_MINUTES,
  GRACE_MINUTES,
  CHECK_INTERVAL_SECONDS
} = process.env;

// -------- 분 단위 설정 --------
const LIMIT_MIN = Math.max(1, parseFloat(DAILY_LIMIT_MINUTES || '120')); // 최소 1분
const GRACE_MIN = Math.max(0, parseFloat(GRACE_MINUTES || '30'));
const CHECK_MS  = Math.max(5, parseInt(CHECK_INTERVAL_SECONDS || '60', 10)) * 1000;

const DAY_MS = 24 * 60 * 60 * 1000; // 시작시간 기준 24시간 주기
const now = () => Date.now();

// -------- DB 초기화 --------
const db = new Database('./fireworks.db');

// 세션 로그
db.exec(`
CREATE TABLE IF NOT EXISTS voice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  join_ts INTEGER NOT NULL,
  leave_ts INTEGER,
  duration_min REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_user ON voice_sessions(user_id, guild_id);

-- "일자" 대신 사용자별 24시간 사용 주기
CREATE TABLE IF NOT EXISTS usage_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cycle_start_ms INTEGER NOT NULL,  -- 이 시각부터 24시간이 한 사이클
  minutes REAL DEFAULT 0,           -- 사이클 내 누적 분
  warned_at INTEGER,                -- 리밋 도달(즉시 강퇴) 시각
  rejoin_at INTEGER,                -- 경고 이후 재입장 시각
  penalized_at INTEGER,             -- 제재(뮤트 등) 확정 시각 => 사이클 종료 전까지 하드락
  UNIQUE(guild_id, user_id, cycle_start_ms)
);
CREATE INDEX IF NOT EXISTS idx_usage_cycles_user ON usage_cycles(guild_id, user_id);
`);

const openSession  = db.prepare(`INSERT INTO voice_sessions (guild_id, user_id, join_ts) VALUES (?, ?, ?)`);
const closeSession = db.prepare(`UPDATE voice_sessions SET leave_ts = ?, duration_min = ? WHERE id = ?`);
const findOpenSes  = db.prepare(`SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND leave_ts IS NULL ORDER BY join_ts DESC LIMIT 1`);

const getLatestCycle = db.prepare(`
  SELECT * FROM usage_cycles
   WHERE guild_id = ? AND user_id = ?
   ORDER BY cycle_start_ms DESC
   LIMIT 1
`);

const createCycle = db.prepare(`
  INSERT INTO usage_cycles (guild_id, user_id, cycle_start_ms, minutes)
  VALUES (?, ?, ?, 0)
  RETURNING *
`);

const addMinutes = db.prepare(`
  UPDATE usage_cycles SET minutes = minutes + ?
   WHERE id = ?
  RETURNING *
`);

const setWarn     = db.prepare(`UPDATE usage_cycles SET warned_at = ?, rejoin_at = NULL WHERE id = ?`);
const setRejoin   = db.prepare(`UPDATE usage_cycles SET rejoin_at = ? WHERE id = ?`);
const setPenalty  = db.prepare(`UPDATE usage_cycles SET penalized_at = ? WHERE id = ?`);

const allOpenNow  = db.prepare(`SELECT DISTINCT guild_id, user_id, join_ts FROM voice_sessions WHERE leave_ts IS NULL`);

// ---- 사이클 헬퍼 ----
function isCycleExpired(cycle, t = now()) {
  return t >= (cycle.cycle_start_ms + DAY_MS);
}
function cycleWindowEndMs(cycle) {
  return cycle.cycle_start_ms + DAY_MS;
}
function ensureActiveCycle(guildId, userId, t = now()) {
  let c = getLatestCycle.get(guildId, userId);
  if (!c || isCycleExpired(c, t)) {
    c = createCycle.get(guildId, userId, t);
  }
  return c;
}
function totalMinutesForCycle(cycle, guildId, userId, t = now()) {
  let total = cycle.minutes;
  const open = findOpenSes.get(guildId, userId);
  if (open && open.join_ts < cycleWindowEndMs(cycle)) {
    const segStart = Math.max(open.join_ts, cycle.cycle_start_ms);
    const segEnd   = Math.min(t, cycleWindowEndMs(cycle));
    if (segEnd > segStart) total += (segEnd - segStart) / 60000;
  }
  return total;
}
// 리밋+그레이스 모두 소진(=사이클 하드락) 여부
function isHardBlocked(cycle, t = now()) {
  if (!cycle) return false;
  if (cycle.penalized_at) return true;
  if (cycle.warned_at && cycle.rejoin_at) {
    return (t - cycle.rejoin_at) >= GRACE_MIN * 60000;
  }
  return false;
}

// -------- Discord --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]
});

// 로그 유틸
async function sendLog(guild, title, lines = []) {
  console.log(`[${guild?.name || 'UnknownGuild'}] ${title}`);
  for (const line of lines) console.log('  ', line);

  try {
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join('\n'))
      .setTimestamp(Date.now());
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('로그 전송 실패:', e.message);
  }
}

// 더 공격적인 강퇴: disconnect → AFK 이동 → 임시 보이스 생성/이동/삭제
async function forceVoiceKick(guild, member) {
  const me = guild.members.me;
  const vc = member.voice?.channel ?? null;

  if (!vc) {
    await sendLog(guild, 'ℹ️ 강제 퇴장 스킵', [
      `유저: <@${member.id}> (${member.user.tag})`, '사유: 이미 음성 채널에 없음'
    ]);
    return true;
  }

  const hasMove      = me.permissions.has(PermissionsBitField.Flags.MoveMembers);
  const hasManageCh  = me.permissions.has(PermissionsBitField.Flags.ManageChannels);
  const meChPerms    = vc.permissionsFor(me);
  const chHasView    = meChPerms?.has(PermissionsBitField.Flags.ViewChannel) ?? false;
  const chHasConnect = meChPerms?.has(PermissionsBitField.Flags.Connect) ?? false;
  const chHasMove    = meChPerms?.has(PermissionsBitField.Flags.MoveMembers) ?? false;

  await sendLog(guild, '🧭 강퇴 진단', [
    `유저: <@${member.id}> (${member.user.tag})`,
    `채널: ${vc.name} (${vc.id})`,
    `Guild권한 Move=${hasMove} ManageCh=${hasManageCh}`,
    `채널권한 View=${chHasView} Connect=${chHasConnect} Move=${chHasMove}`
  ]);

  // 1) 표준 disconnect
  try {
    if ((hasMove || chHasMove) && chHasView) {
      await member.voice.disconnect('Fireworks: limit reached (disconnect)');
      await sendLog(guild, '🔌 음성 강제 퇴장(Disconnect)', []);
      return true;
    }
  } catch (e) {
    await sendLog(guild, '⚠️ Disconnect 실패', [`에러: ${e.message}`]);
  }

  // 2) AFK 이동 후 끊기
  try {
    if (hasMove && guild.afkChannelId) {
      const afk = guild.channels.cache.get(guild.afkChannelId);
      if (afk?.type === ChannelType.GuildVoice) {
        await member.voice.setChannel(afk, 'Fireworks: move to AFK');
        await sendLog(guild, '🔄 AFK 채널로 이동', [`AFK: ${afk.name}`]);
        await member.voice.disconnect().catch(()=>{});
        return true;
      }
    }
  } catch (e) {
    await sendLog(guild, '⚠️ AFK 이동 실패', [`에러: ${e.message}`]);
  }

  // 3) 임시 채널 생성→이동→삭제
  try {
    if (hasMove && hasManageCh) {
      const temp = await guild.channels.create({
        name: 'fw-timeout',
        type: ChannelType.GuildVoice,
        reason: 'Fireworks: temp voice for forced disconnect',
        parent: vc.parentId ?? null,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.Connect] }
        ]
      });
      try {
        await member.voice.setChannel(temp, 'Fireworks: temp move');
        await sendLog(guild, '🛠 임시 채널 이동', [`임시: ${temp.name}`]);
      } catch (e) {
        await sendLog(guild, '⚠️ 임시 채널 이동 실패', [`에러: ${e.message}`]);
      }
      await temp.delete('Fireworks: kick by deleting temp channel');
      await sendLog(guild, '🧹 임시 채널 삭제(강제 퇴장)', []);
      return true;
    }
  } catch (e) {
    await sendLog(guild, '❌ 임시 채널 방식 실패', [`에러: ${e.message}`, `힌트: MoveMembers/ManageChannels 권한 확인`]);
  }

  await sendLog(guild, '❌ 강제 퇴장 불가', ['힌트: 채널/카테고리 권한 또는 봇 권한 확인(봇 역할 우위, MoveMembers 필요)']);
  return false;
}

// 역할 제재(뮤트 먼저, 그다음 미클 역할 제거)
async function applyPenalty(guild, member, reasonLines) {
  const muteRole = guild.roles.cache.get(MUTE_ROLE_ID);
  const mikleMaleId = process.env.MIKLE_MALE_ROLE_ID;
  const mikleFemaleId = process.env.MIKLE_FEMALE_ROLE_ID;

  if (!muteRole) {
    await sendLog(guild, '⚠️ 제재 실패', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `사유: 지정된 뮤트 역할(ID: ${MUTE_ROLE_ID}) 없음`
    ]);
    return false;
  }

  const me = guild.members.me;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await sendLog(guild, '⚠️ 제재 실패', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `사유: 봇에 ManageRoles 권한 없음`
    ]);
    return false;
  }

  try {
    if (!member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, `Daily limit ${LIMIT_MIN}분 초과`);
      await sendLog(guild, '⛔ 제재 적용(뮤트 부여)', [
        `유저: <@${member.id}> (${member.user.tag})`,
        ...reasonLines
      ]);
    }
  } catch (e) {
    await sendLog(guild, '⚠️ 제재 실패(뮤트 부여)', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `에러: ${e.message}`,
      `힌트: 역할 위계 확인(봇 역할이 뮤트 역할보다 위)`
    ]);
    return false;
  }

  const toRemove = [];
  if (mikleMaleId && member.roles.cache.has(mikleMaleId))   toRemove.push(mikleMaleId);
  if (mikleFemaleId && member.roles.cache.has(mikleFemaleId)) toRemove.push(mikleFemaleId);

  if (toRemove.length) {
    try {
      await member.roles.remove(toRemove, 'Fireworks: mute 이후 미클 역할 제거');
      await sendLog(guild, '🔄 미클 역할 제거', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `제거됨: ${toRemove.join(', ')}`
      ]);
    } catch (e) {
      await sendLog(guild, '⚠️ 미클 역할 제거 실패', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `에러: ${e.message}`,
        `힌트: 봇 역할이 해당 역할들보다 위에 있어야 함`
      ]);
    }
  }

  member.send(`⛔ **제재 적용**: 오늘 사용 시간을 초과했습니다. 관리자에게 문의하세요.`).catch(()=>{});
  return true;
}

// ---- 하드락 가드: 재입장 즉시 재퇴장 + 제재 재적용 ----
async function guardOnJoin(guild, member, cycle, t = now()) {
  if (!cycle) return false;

  // 리밋+그레이스 모두 소진(=하드락) 상태인지 계산
  const hardBlocked = isHardBlocked(cycle, t);
  if (!hardBlocked) return false;

  // 그레이스 초과인데 penalized_at이 비어 있는 드문 레이스 케이스 보정
  if (!cycle.penalized_at && cycle.warned_at && cycle.rejoin_at && (t - cycle.rejoin_at) >= GRACE_MIN * 60000) {
    setPenalty.run(t, cycle.id);
  }

  await sendLog(guild, '🚫 입장 즉시 퇴장', [
    `유저: <@${member.id}> (${member.user.tag})`,
    `사이클 시작: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
  ]);

  await forceVoiceKick(guild, member);
  await applyPenalty(guild, member, [
    `사유: LIMIT ${LIMIT_MIN}분 + GRACE ${GRACE_MIN}분 소진`,
    `사이클 시작: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
  ]);
  return true;
}

// -------- 이벤트: 입퇴장 추적 + 사이클 관리 --------
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild  = newState.guild || oldState.guild;
  const member = newState.member || oldState.member;
  if (!guild || !member) return;

  const t = now();

  // 입장
  if (!oldState.channelId && newState.channelId) {
    // 사이클 보장
    let cycle = ensureActiveCycle(guild.id, member.id, t);

    // 하드락이면 즉시 차단(역할 변경으로 우회해도 입장 즉시 퇴장)
    if (await guardOnJoin(guild, member, cycle, t)) return;

    // 세션 오픈
    const open = findOpenSes.get(guild.id, member.id);
    if (!open) openSession.run(guild.id, member.id, t);

    // 경고된 상태에서 재입장 기록
    cycle = getLatestCycle.get(guild.id, member.id); // 최신 보정
    if (cycle?.warned_at && !cycle?.penalized_at && !cycle?.rejoin_at) {
      setRejoin.run(t, cycle.id);
      await sendLog(guild, '↩️ 경고 후 재입장 감지', [
        `유저: <@${member.id}> (${member.user.tag})`
      ]);
    }
    return;
  }

  // 퇴장
  if (oldState.channelId && !newState.channelId) {
    const open = findOpenSes.get(guild.id, member.id);
    if (open) {
      const leave = now();
      const durationMin = Math.max(0, (leave - open.join_ts) / 60000);
      closeSession.run(leave, durationMin, open.id);

      const cycle = ensureActiveCycle(guild.id, member.id, leave);
      const winStart = cycle.cycle_start_ms;
      const winEnd   = cycleWindowEndMs(cycle);
      const segStart = Math.max(open.join_ts, winStart);
      const segEnd   = Math.min(leave, winEnd);
      const addMin   = segEnd > segStart ? (segEnd - segStart) / 60000 : 0;
      if (addMin > 0) addMinutes.get(addMin, cycle.id);
    }
  }
});

// -------- 주기적 감시/제재 루프 --------
async function periodicEnforcer() {
  const t = now();

  // 대상: 현재 음성 + 최근 사이클 보유자
  const openList = allOpenNow.all();
  const userKeys = new Map();
  for (const o of openList) userKeys.set(`${o.guild_id}:${o.user_id}`, { guild_id: o.guild_id, user_id: o.user_id });
  const recentCycles = db.prepare(`
    SELECT guild_id, user_id FROM usage_cycles
     WHERE cycle_start_ms >= ?
  `).all(t - DAY_MS * 2);
  for (const r of recentCycles) userKeys.set(`${r.guild_id}:${r.user_id}`, { guild_id: r.guild_id, user_id: r.user_id });

  for (const { guild_id, user_id } of userKeys.values()) {
    const guild = client.guilds.cache.get(guild_id);
    if (!guild) continue;

    const member = await guild.members.fetch(user_id).catch(() => null);
    if (!member) continue;

    let cycle = ensureActiveCycle(guild_id, user_id, t);

    // 하드락이면 즉시 차단(재접속 타이밍/봇 재시작 사이도 커버)
    if (member.voice?.channelId && isHardBlocked(cycle, t)) {
      await sendLog(guild, '🚫 주기점검: 즉시 강퇴', [
        `유저: <@${member.id}> (${member.user.tag})`
      ]);
      // 위 레이스 보정
      if (!cycle.penalized_at && cycle.warned_at && cycle.rejoin_at && (t - cycle.rejoin_at) >= GRACE_MIN * 60000) {
        setPenalty.run(t, cycle.id);
      }
      await forceVoiceKick(guild, member);
      await applyPenalty(guild, member, [
        `사유: LIMIT ${LIMIT_MIN}분 + GRACE ${GRACE_MIN}분 소진`,
        `시작 시간: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
      ]);
      continue;
    }

    // 누적 계산
    const totalMin = totalMinutesForCycle(cycle, guild_id, user_id, t);

    // A) 리밋 도달 & 경고 전 → 즉시 강퇴 + 경고 플래그
    if (totalMin >= LIMIT_MIN && !cycle.warned_at) {
      setWarn.run(t, cycle.id);

      try {
        await member.send(
          `⚠️ **오늘 사용 시간이 ${LIMIT_MIN}분을 초과했습니다.**\n` +
          `지금은 강제로 음성 채널에서 퇴장됩니다.\n` +
          `↩️ 재입장은 가능하지만, **재입장 후 ${GRACE_MIN}분**을 넘기면 자동으로 제재(역할 변경, 이용 제한)가 적용됩니다.`
        ).catch(()=>{});
      } catch {}

      await sendLog(guild, '⏰ 리밋 도달 → 즉시 강제 퇴장', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${totalMin.toFixed(1)}분`,
        `시작 시간: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
      ]);
      await forceVoiceKick(guild, member);
      continue;
    }

    // B) 경고 되었고 재입장 기록 없는데 현재 음성 중 → rejoin 보정
    if (cycle.warned_at && !cycle.penalized_at && !cycle.rejoin_at && member.voice?.channelId) {
      setRejoin.run(t, cycle.id);
      await sendLog(guild, '↩️ 재입장 시각 자동 보정', [
        `유저: <@${member.id}> (${member.user.tag})`
      ]);
      continue;
    }

    // C) 재입장 후 GRACE 경과 → 강제 퇴장 + 역할 제재 + 하드락 확정
    if (cycle.warned_at && cycle.rejoin_at && !cycle.penalized_at && member.voice?.channelId) {
      const elapsedMin = (t - cycle.rejoin_at) / 60000;
      if (elapsedMin >= GRACE_MIN) {
        await sendLog(guild, '⛔ 재입장 후 GRACE 초과 → 제재', [
          `유저: <@${member.id}> (${member.user.tag})`,
          `경과: ${elapsedMin.toFixed(1)}분`
        ]);

        await forceVoiceKick(guild, member);
        await applyPenalty(guild, member, [
          `사유: LIMIT ${LIMIT_MIN}분 초과 후 재입장 + GRACE ${GRACE_MIN}분 경과`,
          `시작 시간: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
        ]);

        setPenalty.run(t, cycle.id); // → 사이클 종료 전까지 하드락
        continue;
      }
    }
  }
}

setInterval(() => {
  periodicEnforcer().catch(e => console.error('periodicEnforcer error:', e));
}, CHECK_MS);

// -------- 부팅 시 정리 --------
client.once('ready', async () => {
  console.log(`Fireworks bot ready as ${client.user.tag}`);

  // 열린 세션 정리(비정상 종료 보정)
  const t = now();
  db.exec(`
    UPDATE voice_sessions
       SET leave_ts = COALESCE(leave_ts, ${t}),
           duration_min = CASE WHEN leave_ts IS NULL THEN (${t} - join_ts)/60000 ELSE duration_min END
     WHERE leave_ts IS NULL;
  `);

  // 현재 음성 사용자 → 세션 오픈 + 사이클 보장 + 하드락 즉시 가드
  for (const [, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.filter(c => c.isVoiceBased?.());
    for (const [, ch] of channels) {
      for (const [, m] of ch.members) {
        const cycle = ensureActiveCycle(guild.id, m.id, t);
        const open = findOpenSes.get(guild.id, m.id);
        if (!open) openSession.run(guild.id, m.id, t);
        await guardOnJoin(guild, m, cycle, t); // 부팅 시 이미 채널에 있는 하드락 대상 즉시 퇴장
      }
    }
  }

  // 부팅 즉시 1회 수행
  periodicEnforcer().catch(()=>{});
});

client.login(DISCORD_TOKEN);

// fireworks-bot.js
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType
} = require('discord.js');
const Database = require('better-sqlite3');

// ---------------- ENV ----------------
const {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  MUTE_ROLE_ID,
  MIKLE_MALE_ROLE_ID,
  MIKLE_FEMALE_ROLE_ID,
  ADMIN_ROLE_ID,                 // ✅ 관리자 역할 제한
  DAILY_LIMIT_MINUTES,
  GRACE_MINUTES,
  CHECK_INTERVAL_SECONDS,
  REGISTER_COMMANDS_ON_BOOT,
  DB_PATH
} = process.env;

// ---------------- 기본 상수 ----------------
const LIMIT_MIN = Math.max(1, parseFloat(DAILY_LIMIT_MINUTES || '120')); // 최소 1분
const GRACE_MIN = Math.max(0, parseFloat(GRACE_MINUTES || '30'));
const CHECK_MS  = Math.max(5, parseInt(CHECK_INTERVAL_SECONDS || '60', 10)) * 1000;
const DAY_MS    = 24 * 60 * 60 * 1000;
const now = () => Date.now();

// ---------------- Discord Client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // 역할/멤버 조회
    GatewayIntentBits.GuildVoiceStates, // 음성 상태
  ],
});

// ---------------- DB ----------------
const db = new Database(DB_PATH || './fireworks.db');

// 스키마
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

CREATE TABLE IF NOT EXISTS usage_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cycle_start_ms INTEGER NOT NULL,  -- 시작 기준 24h
  minutes REAL DEFAULT 0,           -- 사용 누적(분)
  warned_at INTEGER,                -- 리밋 도달 경고 시각
  rejoin_at INTEGER,                -- 경고 후 재입장 시각
  penalized_at INTEGER,             -- 하드락 확정 시각
  bonus_min REAL DEFAULT 0,         -- ✅ 보너스(리밋 가산)
  UNIQUE(guild_id, user_id, cycle_start_ms)
);
CREATE INDEX IF NOT EXISTS idx_usage_cycles_user ON usage_cycles(guild_id, user_id);
`);
try { db.exec(`ALTER TABLE usage_cycles ADD COLUMN bonus_min REAL DEFAULT 0;`); } catch {}

// prepared statements
const openSession  = db.prepare(`INSERT INTO voice_sessions (guild_id, user_id, join_ts) VALUES (?, ?, ?)`);
const closeSession = db.prepare(`UPDATE voice_sessions SET leave_ts = ?, duration_min = ? WHERE id = ?`);
const findOpenSes  = db.prepare(`SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND leave_ts IS NULL ORDER BY join_ts DESC LIMIT 1`);
const allOpenNow   = db.prepare(`SELECT DISTINCT guild_id, user_id, join_ts FROM voice_sessions WHERE leave_ts IS NULL`);

const getLatestCycle = db.prepare(`
  SELECT * FROM usage_cycles
   WHERE guild_id = ? AND user_id = ?
   ORDER BY cycle_start_ms DESC
   LIMIT 1
`);
const createCycle = db.prepare(`
  INSERT INTO usage_cycles (guild_id, user_id, cycle_start_ms, minutes, bonus_min)
  VALUES (?, ?, ?, 0, 0)
  RETURNING *
`);
const addUsageMinutes = db.prepare(`
  UPDATE usage_cycles SET minutes = minutes + ?
   WHERE id = ?
  RETURNING *
`);
const addBonusMinutes = db.prepare(`
  UPDATE usage_cycles SET bonus_min = bonus_min + ?
   WHERE id = ?
  RETURNING *
`);
const resetPenaltyFlags = db.prepare(`
  UPDATE usage_cycles SET warned_at=NULL, rejoin_at=NULL, penalized_at=NULL WHERE id = ?
`);
const setWarn    = db.prepare(`UPDATE usage_cycles SET warned_at = ?, rejoin_at = NULL WHERE id = ?`);
const setRejoin  = db.prepare(`UPDATE usage_cycles SET rejoin_at = ? WHERE id = ?`);
const setPenalty = db.prepare(`UPDATE usage_cycles SET penalized_at = ? WHERE id = ?`);

// ---------------- 사이클 유틸 ----------------
function isCycleExpired(cycle, t = now()) { return t >= (cycle.cycle_start_ms + DAY_MS); }
function cycleWindowEndMs(cycle) { return cycle.cycle_start_ms + DAY_MS; }
function ensureActiveCycle(guildId, userId, t = now()) {
  let c = getLatestCycle.get(guildId, userId);
  if (!c || isCycleExpired(c, t)) c = createCycle.get(guildId, userId, t);
  return c;
}
function effectiveLimit(cycle) {
  const bonus = Number(cycle?.bonus_min || 0);
  return LIMIT_MIN + Math.max(0, bonus);
}
function totalMinutesForCycle(cycle, guildId, userId, t = now()) {
  let total = Number(cycle.minutes || 0);
  const open = findOpenSes.get(guildId, userId);
  if (open && open.join_ts < cycleWindowEndMs(cycle)) {
    const segStart = Math.max(open.join_ts, cycle.cycle_start_ms);
    const segEnd   = Math.min(t, cycleWindowEndMs(cycle));
    if (segEnd > segStart) total += (segEnd - segStart) / 60000;
  }
  return total;
}
function isHardBlocked(cycle, guildId, userId, t = now()) {
  if (!cycle) return false;
  const limitNow = effectiveLimit(cycle);
  const totalMin = totalMinutesForCycle(cycle, guildId, userId, t);
  if (totalMin < limitNow) return false;
  if (cycle.penalized_at) return true;
  if (cycle.warned_at && cycle.rejoin_at) {
    return (t - cycle.rejoin_at) >= GRACE_MIN * 60000;
  }
  return false;
}

// ---------------- 로그 유틸 ----------------
async function sendLog(guild, title, lines = []) {
  console.log(`[${guild?.name || 'UnknownGuild'}] ${title}`);
  for (const line of lines) console.log('  ', line);
  try {
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n')).setTimestamp(Date.now());
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('로그 전송 실패:', e.message);
  }
}

// ---------------- 강제 퇴장 ----------------
async function forceVoiceKick(guild, member) {
  const me = guild.members.me;
  const vc = member.voice?.channel ?? null;

  if (!vc) {
    await sendLog(guild, 'ℹ️ 강제 퇴장 스킵', [`유저: <@${member.id}> (${member.user.tag})`, '사유: 음성 채널 아님']);
    return true;
  }

  const hasMove     = me.permissions.has(PermissionsBitField.Flags.MoveMembers);
  const hasManageCh = me.permissions.has(PermissionsBitField.Flags.ManageChannels);
  const meChPerms   = vc.permissionsFor(me);
  const chHasView   = meChPerms?.has(PermissionsBitField.Flags.ViewChannel) ?? false;
  const chHasMove   = meChPerms?.has(PermissionsBitField.Flags.MoveMembers) ?? false;

  await sendLog(guild, '🧭 강퇴 진단', [
    `유저: <@${member.id}> (${member.user.tag})`,
    `채널: ${vc.name} (${vc.id})`,
    `Guild권한 Move=${hasMove} ManageCh=${hasManageCh}`,
    `채널권한 View=${chHasView} Move=${chHasMove}`
  ]);

  // 1) 표준 disconnect
  try {
    if ((hasMove || chHasMove) && chHasView) {
      await member.voice.disconnect('Fireworks: limit reached');
      await sendLog(guild, '🔌 음성 강제 퇴장(Disconnect)', []);
      return true;
    }
  } catch (e) {
    await sendLog(guild, '⚠️ Disconnect 실패', [`에러: ${e.message}`]);
  }

  // 2) AFK 이동 + disconnect
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

  // 3) 임시 채널 생성 → 이동 → 삭제로 끊기
  try {
    if (hasMove && hasManageCh) {
      const temp = await guild.channels.create({
        name: 'fw-timeout',
        type: ChannelType.GuildVoice,
        reason: 'Fireworks: temp voice for forced disconnect',
        parent: vc.parentId ?? null,
        permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionsBitField.Flags.Connect] }]
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

  await sendLog(guild, '❌ 강제 퇴장 불가', ['힌트: 봇 역할 권한/위치 검토 필요']);
  return false;
}

// ---------------- 역할 제재 ----------------
async function applyPenalty(guild, member, reasonLines) {
  const muteRole = guild.roles.cache.get(MUTE_ROLE_ID);
  if (!muteRole) {
    await sendLog(guild, '⚠️ 제재 실패', [`유저: <@${member.id}> (${member.user.tag})`, `사유: 뮤트 역할(ID:${MUTE_ROLE_ID}) 없음`]);
    return false;
  }

  const me = guild.members.me;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await sendLog(guild, '⚠️ 제재 실패', [`유저: <@${member.id}> (${member.user.tag})`, `사유: 봇에 ManageRoles 권한 없음`]);
    return false;
  }

  try {
    if (!member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, `Limit exceeded`);
      await sendLog(guild, '⛔ 제재 적용(뮤트 부여)', [`유저: <@${member.id}> (${member.user.tag})`, ...reasonLines]);
    }
  } catch (e) {
    await sendLog(guild, '⚠️ 제재 실패(뮤트 부여)', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `에러: ${e.message}`,
      `힌트: 봇 역할이 뮤트 역할보다 위여야 함`
    ]);
    return false;
  }

  const toRemove = [];
  if (MIKLE_MALE_ROLE_ID && member.roles.cache.has(MIKLE_MALE_ROLE_ID)) toRemove.push(MIKLE_MALE_ROLE_ID);
  if (MIKLE_FEMALE_ROLE_ID && member.roles.cache.has(MIKLE_FEMALE_ROLE_ID)) toRemove.push(MIKLE_FEMALE_ROLE_ID);
  if (toRemove.length) {
    try {
      await member.roles.remove(toRemove, 'Fireworks: mute 이후 미클 역할 제거');
      await sendLog(guild, '🔄 미클 역할 제거', [`유저: <@${member.id}> (${member.user.tag})`, `제거됨: ${toRemove.join(', ')}`]);
    } catch (e) {
      await sendLog(guild, '⚠️ 미클 역할 제거 실패', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `에러: ${e.message}`,
        `힌트: 봇 역할이 해당 역할보다 위여야 함`
      ]);
    }
  }

  member.send(`⛔ **제재 적용**: 사용 한도를 초과했습니다. 사이클 종료까지 음성 이용이 제한됩니다.`).catch(()=>{});
  return true;
}

// ---------------- 하드락 가드(입장 즉시 퇴장) ----------------
async function guardOnJoin(guild, member, cycle, t = now()) {
  if (!cycle) return false;

  const hardBlocked = isHardBlocked(cycle, guild.id, member.id, t);
  if (!hardBlocked) return false;

  // 경과 보정
  if (!cycle.penalized_at && cycle.warned_at && cycle.rejoin_at && (t - cycle.rejoin_at) >= GRACE_MIN * 60000) {
    setPenalty.run(t, cycle.id);
  }

  const totalMin = totalMinutesForCycle(cycle, guild.id, member.id, t);
  const limitNow = effectiveLimit(cycle);

  // 직전 보너스로 해제된 경우
  if (totalMin < limitNow) {
    resetPenaltyFlags.run(cycle.id);
    await sendLog(guild, '✅ 하드락 해제(보너스 반영)', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `유효리밋: ${limitNow}분, 누적: ${totalMin.toFixed(1)}분`
    ]);
    return false;
  }

  await sendLog(guild, '🚫 입장 즉시 퇴장(하드락)', [
    `유저: <@${member.id}> (${member.user.tag})`,
    `사이클 시작: ${new Date(cycle.cycle_start_ms).toLocaleString()}`,
    `누적: ${totalMin.toFixed(1)} / 유효리밋: ${limitNow}`
  ]);

  await forceVoiceKick(guild, member);
  await applyPenalty(guild, member, [
    `사유: LIMIT ${limitNow}분 + GRACE ${GRACE_MIN}분 소진`,
    `사이클 시작: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
  ]);
  return true;
}

// ---------------- 이벤트: voiceStateUpdate ----------------
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild  = newState.guild || oldState.guild;
  const member = newState.member || oldState.member;
  if (!guild || !member) return;

  const t = now();

  // 입장
  if (!oldState.channelId && newState.channelId) {
    let cycle = ensureActiveCycle(guild.id, member.id, t);
    if (await guardOnJoin(guild, member, cycle, t)) return;

    const open = findOpenSes.get(guild.id, member.id);
    if (!open) openSession.run(guild.id, member.id, t);

    cycle = getLatestCycle.get(guild.id, member.id);
    if (cycle?.warned_at && !cycle?.penalized_at && !cycle?.rejoin_at) {
      setRejoin.run(t, cycle.id);
      await sendLog(guild, '↩️ 경고 후 재입장 감지', [`유저: <@${member.id}> (${member.user.tag})`]);
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
      if (addMin > 0) addUsageMinutes.get(addMin, cycle.id);
    }
  }
});

// ---------------- 주기적 점검/집행 ----------------
async function periodicEnforcer() {
  const t = now();

  const openList = allOpenNow.all();
  const userKeys = new Map();
  for (const o of openList) userKeys.set(`${o.guild_id}:${o.user_id}`, { guild_id: o.guild_id, user_id: o.user_id });
  const recentCycles = db.prepare(`SELECT guild_id, user_id FROM usage_cycles WHERE cycle_start_ms >= ?`).all(t - DAY_MS * 2);
  for (const r of recentCycles) userKeys.set(`${r.guild_id}:${r.user_id}`, { guild_id: r.guild_id, user_id: r.user_id });

  for (const { guild_id, user_id } of userKeys.values()) {
    const guild = client.guilds.cache.get(guild_id);
    if (!guild) continue;
    const member = await guild.members.fetch(user_id).catch(() => null);
    if (!member) continue;

    let cycle = ensureActiveCycle(guild_id, user_id, t);

    // 하드락 즉시 처리
    if (member.voice?.channelId && isHardBlocked(cycle, guild_id, user_id, t)) {
      const totalMin = totalMinutesForCycle(cycle, guild_id, user_id, t);
      const limitNow = effectiveLimit(cycle);

      await sendLog(guild, '🚫 주기점검: 즉시 강퇴(하드락)', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${totalMin.toFixed(1)} / 유효리밋: ${limitNow}`
      ]);

      if (!cycle.penalized_at && cycle.warned_at && cycle.rejoin_at && (t - cycle.rejoin_at) >= GRACE_MIN * 60000) {
        setPenalty.run(t, cycle.id);
      }
      await forceVoiceKick(guild, member);
      await applyPenalty(guild, member, [
        `사유: LIMIT ${limitNow}분 + GRACE ${GRACE_MIN}분 소진`,
        `시작 시간: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
      ]);
      continue;
    }

    // 누적 계산 및 경고/제재 판단
    const totalMin = totalMinutesForCycle(cycle, guild_id, user_id, t);
    const limitNow = effectiveLimit(cycle);

    // A) 리밋 도달 & 경고 전 → 즉시 강퇴 + 경고
    if (totalMin >= limitNow && !cycle.warned_at) {
      setWarn.run(t, cycle.id);
      member.send(
        `⚠️ **사용 시간이 ${limitNow}분을 초과했습니다.**\n` +
        `지금은 강제로 음성 채널에서 퇴장됩니다.\n` +
        `↩️ 재입장은 가능하지만, **재입장 후 ${GRACE_MIN}분**을 넘기면 자동으로 제재가 적용됩니다.`
      ).catch(()=>{});
      await sendLog(guild, '⏰ 리밋 도달 → 즉시 강제 퇴장', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${totalMin.toFixed(1)}분 / 유효리밋: ${limitNow}분`,
        `시작 시간: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
      ]);
      await forceVoiceKick(guild, member);
      continue;
    }

    // B) 경고 후 재입장 보정
    if (cycle.warned_at && !cycle.penalized_at && !cycle.rejoin_at && member.voice?.channelId) {
      setRejoin.run(t, cycle.id);
      await sendLog(guild, '↩️ 재입장 시각 자동 보정', [`유저: <@${member.id}> (${member.user.tag})`]);
      continue;
    }

    // C) 재입장 후 GRACE 초과 → 강퇴 + 역할 제재 + 하드락 확정
    if (cycle.warned_at && cycle.rejoin_at && !cycle.penalized_at && member.voice?.channelId) {
      const elapsedMin = (t - cycle.rejoin_at) / 60000;
      if (elapsedMin >= GRACE_MIN) {
        await sendLog(guild, '⛔ 재입장 후 GRACE 초과 → 제재', [
          `유저: <@${member.id}> (${member.user.tag})`,
          `경과: ${elapsedMin.toFixed(1)}분`
        ]);
        await forceVoiceKick(guild, member);
        await applyPenalty(guild, member, [
          `사유: LIMIT ${limitNow}분 초과 후 재입장 + GRACE ${GRACE_MIN}분 경과`,
          `시작 시간: ${new Date(cycle.cycle_start_ms).toLocaleString()}`
        ]);
        setPenalty.run(t, cycle.id);
        continue;
      }
    }
  }
}
setInterval(() => periodicEnforcer().catch(e => console.error('periodicEnforcer error:', e)), CHECK_MS);

// ---------------- Slash Commands ----------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  const t = now();

  if (commandName === 'time_check') {
    const targetUser = interaction.options.getUser('user');
    const cycle = ensureActiveCycle(interaction.guild.id, targetUser.id, t);
    const totalMin = totalMinutesForCycle(cycle, interaction.guild.id, targetUser.id, t);
    const limitNow = effectiveLimit(cycle);
    const remaining = Math.max(0, limitNow - totalMin);
    const endAt = new Date(cycleWindowEndMs(cycle)).toLocaleString();

    await interaction.reply({
      content:
        `⏱ **${targetUser.username}** 님\n` +
        `• 누적: **${totalMin.toFixed(1)}분**\n` +
        `• 유효 리밋: **${limitNow}분** (기본 ${LIMIT_MIN} + 보너스 ${cycle.bonus_min || 0})\n` +
        `• 남은 시간: **${remaining.toFixed(1)}분**\n` +
        `• 사이클 종료: ${endAt}`,
      ephemeral: true
    });
    return;
  }

  if (commandName === 'time_add') {
    // ✅ 관리자 역할만 허용
    const hasAdminRole = interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID);
    if (!hasAdminRole) {
      return interaction.reply({ content: '🚫 이 명령어는 **관리자 역할** 보유자만 사용할 수 있습니다.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('user');
    const addMin = interaction.options.getInteger('minutes') || 60;
    if (addMin <= 0) {
      return interaction.reply({ content: '추가 분은 1분 이상이어야 합니다.', ephemeral: true });
    }

    let cycle = ensureActiveCycle(interaction.guild.id, targetUser.id, t);
    cycle = addBonusMinutes.get(addMin, cycle.id);

    const totalMin = totalMinutesForCycle(cycle, interaction.guild.id, targetUser.id, t);
    const limitNow = effectiveLimit(cycle);
    let note = '';

    // 보너스로 즉시 해제되는 경우 플래그 리셋
    if (totalMin < limitNow && (cycle.warned_at || cycle.penalized_at)) {
      resetPenaltyFlags.run(cycle.id);
      note = ' (하드락 해제됨)';
      const member = await interaction.guild.members.fetch(targetUser.id).catch(()=>null);
      if (member) member.send(`✅ 관리자에 의해 **${addMin}분** 보너스가 추가되어 사용이 재개되었습니다.`).catch(()=>{});
    }

    await interaction.reply({
      content: `➕ **${targetUser.username}** 님에게 **${addMin}분** 보너스를 부여했습니다${note}\n` +
               `현재 유효 리밋: ${limitNow}분, 누적: ${totalMin.toFixed(1)}분`,
      ephemeral: true
    });

    await sendLog(interaction.guild, '⏫ 시간(리밋) 추가', [
      `관리자: <@${interaction.user.id}>`,
      `대상: <@${targetUser.id}>`,
      `보너스: ${addMin}분`,
      `유효리밋: ${limitNow}분, 누적: ${totalMin.toFixed(1)}분${note}`
    ]);
    return;
  }
});

// ---------------- Ready / 초기 정리 & (옵션) 명령어 등록 ----------------
client.once('ready', async () => {
  console.log(`✅ Fireworks bot ready as ${client.user.tag}`);

  // (옵션) 부팅 시 글로벌 커맨드 등록
  if (REGISTER_COMMANDS_ON_BOOT === '1') {
    try {
      await client.application?.commands.set([
        {
          name: 'time_check',
          description: '특정 유저의 현재 누적 시간과 남은 시간 확인',
          options: [{ name: 'user', description: '확인할 유저', type: 6, required: true }]
        },
        {
          name: 'time_add',
          description: '특정 유저의 사용 가능 시간을 추가(리밋 보너스)',
          options: [
            { name: 'user', description: '시간을 추가할 유저', type: 6, required: true },
            { name: 'minutes', description: '추가할 시간(분, 기본 60)', type: 4, required: false }
          ]
        }
      ]);
      console.log('✅ Slash Commands registered (global)');
    } catch (e) {
      console.error('❌ Command register failed:', e);
    }
  }

  // 열린 세션 보정
  const t = now();
  db.exec(`
    UPDATE voice_sessions
       SET leave_ts = COALESCE(leave_ts, ${t}),
           duration_min = CASE WHEN leave_ts IS NULL THEN (${t} - join_ts)/60000 ELSE duration_min END
     WHERE leave_ts IS NULL
  `);

  // 현재 음성 사용자 세션+사이클 보장 및 하드락 즉시 처리
  for (const [, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.filter(c => c.isVoiceBased?.());
    for (const [, ch] of channels) {
      for (const [, m] of ch.members) {
        const cycle = ensureActiveCycle(guild.id, m.id, t);
        const open = findOpenSes.get(guild.id, m.id);
        if (!open) openSession.run(guild.id, m.id, t);
        await guardOnJoin(guild, m, cycle, t);
      }
    }
  }

  periodicEnforcer().catch(()=>{});
});

client.login(DISCORD_TOKEN);

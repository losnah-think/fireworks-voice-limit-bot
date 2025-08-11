require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const Database = require('better-sqlite3');

const {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  MUTE_ROLE_ID,
  DAILY_LIMIT_MINUTES,
  GRACE_MINUTES,
  CHECK_INTERVAL_SECONDS
} = process.env;

// 소수점 분 지원 (0.5분 = 30초)
const LIMIT = parseFloat(DAILY_LIMIT_MINUTES || '120');
const GRACE = parseFloat(GRACE_MINUTES || '30');
const CHECK_MS = parseInt(CHECK_INTERVAL_SECONDS || '60', 10) * 1000;

const db = new Database('./fireworks.db');

// ---------- DB 초기화 ----------
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

CREATE TABLE IF NOT EXISTS daily_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  minutes REAL DEFAULT 0,
  warned_at INTEGER,
  grace_until INTEGER,      -- (과거 호환용: 지금 로직은 rejoin 기준이므로 선택 사용)
  rejoin_at INTEGER,        -- 경고 이후 "재입장" 시각
  penalized_at INTEGER,
  pre_notified INTEGER DEFAULT 0,
  UNIQUE(date_key, guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_user ON daily_usage(user_id, guild_id, date_key);
CREATE INDEX IF NOT EXISTS idx_daily_usage_dgu ON daily_usage(date_key, guild_id, user_id);
`);

const upsertDaily = db.prepare(`
INSERT INTO daily_usage (date_key, guild_id, user_id, minutes)
VALUES (@date_key, @guild_id, @user_id, @minutes)
ON CONFLICT(date_key, guild_id, user_id)
DO UPDATE SET minutes = minutes + excluded.minutes
RETURNING *;
`);

const ensureDailyRow = db.prepare(`
INSERT INTO daily_usage (date_key, guild_id, user_id, minutes)
VALUES (?, ?, ?, 0)
ON CONFLICT(date_key, guild_id, user_id) DO NOTHING;
`);

const getDaily       = db.prepare(`SELECT * FROM daily_usage WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const setWarn        = db.prepare(`UPDATE daily_usage SET warned_at = ?, grace_until = NULL, rejoin_at = NULL WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const setRejoin      = db.prepare(`UPDATE daily_usage SET rejoin_at = ? WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const setPenalty     = db.prepare(`UPDATE daily_usage SET penalized_at = ? WHERE date_key = ? AND guild_id = ? AND user_id = ?`);

const openSession    = db.prepare(`INSERT INTO voice_sessions (guild_id, user_id, join_ts) VALUES (?, ?, ?)`);
const closeSession   = db.prepare(`UPDATE voice_sessions SET leave_ts = ?, duration_min = ? WHERE id = ?`);
const findOpenSes    = db.prepare(`SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND leave_ts IS NULL ORDER BY join_ts DESC LIMIT 1`);
const allOpenNow     = db.prepare(`SELECT DISTINCT guild_id, user_id, join_ts FROM voice_sessions WHERE leave_ts IS NULL`);
const todaysRows     = db.prepare(`SELECT * FROM daily_usage WHERE date_key = ?`);

const KST_OFFSET = 9 * 60 * 60 * 1000;
const now = () => Date.now();
function todayKSTKey(ts = now()) {
  const k = new Date(ts + KST_OFFSET);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}
function startOfTodayKSTMs(ts = now()) {
  const d = new Date(ts + KST_OFFSET);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - KST_OFFSET; // KST 자정의 UTC epoch(ms)
}

// ---------- Discord ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]
});

// 로그 유틸 (콘솔 + Discord 동시)
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

// 강제 퇴장 유틸 (다단계 시도 + 상세 로깅)
async function forceVoiceKick(guild, member) {
  const me = guild.members.me;
  const vc = member.voice?.channel ?? null;

  if (!vc) {
    await sendLog(guild, 'ℹ️ 강제 퇴장 스킵', [
      `유저: <@${member.id}> (${member.user.tag})`, '사유: 이미 음성 채널에 없음'
    ]);
    return true;
  }

  const hasMove     = me.permissions.has(PermissionsBitField.Flags.MoveMembers);
  const hasManageCh = me.permissions.has(PermissionsBitField.Flags.ManageChannels);
  const p = vc.permissionsFor(me);
  const chHasView   = p?.has(PermissionsBitField.Flags.ViewChannel) ?? false;
  const chHasConnect= p?.has(PermissionsBitField.Flags.Connect) ?? false;
  const chHasMove   = p?.has(PermissionsBitField.Flags.MoveMembers) ?? false;

  await sendLog(guild, '🧭 강퇴 진단', [
    `유저: <@${member.id}> (${member.user.tag})`,
    `채널: ${vc.name} (${vc.id})`,
    `Guild권한 Move=${hasMove} ManageCh=${hasManageCh}`,
    `채널권한 View=${chHasView} Connect=${chHasConnect} Move=${chHasMove}`
  ]);

  // 1) 표준 disconnect
  try {
    if (hasMove && chHasMove && chHasView) {
      await member.voice.disconnect('Fireworks: real-time limit kick');
      await sendLog(guild, '🔌 음성 강제 퇴장(Disconnect)', []);
      return true;
    }
  } catch (e) {
    await sendLog(guild, '⚠️ Disconnect 실패', [`에러: ${e.message}`]);
  }

  // 2) AFK 이동
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
        parent: vc.parentId ?? null
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

  await sendLog(guild, '❌ 강제 퇴장 불가', ['힌트: 채널/카테고리 권한 또는 봇 권한 확인']);
  return false;
}

// 역할 부여(참여 제한) — 먼저 "뮤트" 부여, 그다음 미클남/미클여 제거
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

  // 1) 뮤트 먼저 부여
  try {
    if (!member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, `Daily limit ${LIMIT}m exceeded; (rejoin grace ${GRACE}m)`);
      await sendLog(guild, '⛔ 제재 적용(뮤트 먼저 부여)', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `조치: 뮤트 역할 부여`,
        ...reasonLines
      ]);
    }
  } catch (e) {
    await sendLog(guild, '⚠️ 제재 실패(뮤트 부여)', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `에러: ${e.message}`,
      `힌트: 역할 위계/권한 확인 (봇 역할이 뮤트 역할보다 위)`
    ]);
    return false;
  }

  // 2) 미클남/미클여가 있으면 제거
  const toRemove = [];
  if (mikleMaleId && member.roles.cache.has(mikleMaleId))   toRemove.push(mikleMaleId);
  if (mikleFemaleId && member.roles.cache.has(mikleFemaleId)) toRemove.push(mikleFemaleId);

  if (toRemove.length) {
    try {
      await member.roles.remove(toRemove, 'Fireworks: mute 적용 후 미클 역할 제거');
      await sendLog(guild, '🔄 미클 역할 제거', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `제거됨: ${toRemove.join(', ')}`
      ]);
    } catch (e) {
      await sendLog(guild, '⚠️ 미클 역할 제거 실패', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `에러: ${e.message}`,
        `힌트: 봇 역할이 미클 역할들보다 위에 있어야 합니다.`
      ]);
      // 뮤트는 이미 걸렸으니 실패해도 제재 상태는 유지
    }
  }

  // DM 알림(실패 무시)
  await member.send('⛔ 유예 종료로 **제재(뮤트 역할)**가 적용되었고, 기존 미클 역할이 제거되었습니다.').catch(()=>{});
  return true;
}

// ---------- 이벤트: 세션 기록 + 재입장 감지 ----------
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild  = newState.guild || oldState.guild;
  const member = newState.member || oldState.member;
  if (!guild || !member) return;

  const dateKey = todayKSTKey();

  // 입장 → 세션 오픈 + (경고된 사용자면) 재입장 시각 기록
  if (!oldState.channelId && newState.channelId) {
    const open = findOpenSes.get(guild.id, member.id);
    if (!open) openSession.run(guild.id, member.id, now());

    const du = getDaily.get(dateKey, guild.id, member.id);
    if (du?.warned_at && !du?.penalized_at) {
      ensureDailyRow.run(dateKey, guild.id, member.id); // 없으면 생성
      setRejoin.run(now(), dateKey, guild.id, member.id);
      await sendLog(guild, '↩️ 경고 후 재입장 감지', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `재입장 시각 기록`
      ]);
    }
    return;
  }

  // 퇴장 → 세션 종료 + 분 누적
  if (oldState.channelId && !newState.channelId) {
    const open = findOpenSes.get(guild.id, member.id);
    if (open) {
      const leave = now();
      const durationMin = (leave - open.join_ts) / 60000;
      closeSession.run(leave, durationMin, open.id);
      upsertDaily.run({ date_key: dateKey, guild_id: guild.id, user_id: member.id, minutes: durationMin });
    }
  }
});

// ---------- 비동기 루프: 실시간 제재 ----------
async function periodicEnforcer() {
  const dateKey = todayKSTKey();

  // 오늘 활동 대상: daily rows + 현재 음성 중
  const rows = todaysRows.all(dateKey);
  const openList = allOpenNow.all();
  const users = new Map();
  for (const r of rows) users.set(`${r.guild_id}:${r.user_id}`, { guild_id: r.guild_id, user_id: r.user_id });
  for (const o of openList) users.set(`${o.guild_id}:${o.user_id}`, { guild_id: o.guild_id, user_id: o.user_id });

  for (const { guild_id, user_id } of users.values()) {
    const guild = client.guilds.cache.get(guild_id);
    if (!guild) continue;

    const member = await guild.members.fetch(user_id).catch(() => null);
    if (!member) continue;

    const du = getDaily.get(dateKey, guild_id, user_id);
    let total = du?.minutes || 0;
    const open = findOpenSes.get(guild_id, user_id);
    if (open) {
      const start = Math.max(open.join_ts, startOfTodayKSTMs());
      if (now() > start) total += (now() - start) / 60000;
    }

    // A) LIMIT 초과 & 경고 전 → 즉시 강퇴 + DM + warned_at 기록
    if (total >= LIMIT && !(du?.warned_at)) {
      ensureDailyRow.run(dateKey, guild_id, user_id); // 없으면 생성
      setWarn.run(now(), dateKey, guild_id, user_id);

      try {
        const secs = Math.round(GRACE * 60);
        await member.send(
          `⚠️ **오늘 게임 시간이 ${LIMIT}분을 초과했습니다.**\n` +
          `↩️ 다시 입장할 수 있지만, 입장 후 **${secs}초**가 지나면 자동 제재됩니다.`
        ).catch(()=>{});
      } catch {}

      await sendLog(guild, '⏰ 리밋 도달 → 즉시 강제 퇴장', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${total.toFixed(1)}분`
      ]);
      await forceVoiceKick(guild, member);
      continue;
    }

    // B) 경고 후 재입장했는지 보정: warned_at 있고 rejoin_at 없는데 현재 음성에 있으면 rejoin_at 세팅
    if (du?.warned_at && !du?.penalized_at && !du?.rejoin_at && member.voice?.channelId) {
      ensureDailyRow.run(dateKey, guild_id, user_id); // 없으면 생성
      setRejoin.run(now(), dateKey, guild_id, user_id);
      await sendLog(guild, '↩️ 재입장 시각 자동 보정', [
        `유저: <@${member.id}> (${member.user.tag})`
      ]);
      continue;
    }

    // C) 재입장 후 GRACE 경과 → 강제 퇴장 + 역할 부여
    if (du?.warned_at && du?.rejoin_at && !du?.penalized_at && member.voice?.channelId) {
      const delta = now() - du.rejoin_at;
      if (delta >= GRACE * 60 * 1000) {
        await sendLog(guild, '⛔ 재입장 후 GRACE 초과 → 제재', [
          `유저: <@${member.id}> (${member.user.tag})`,
          `경과: ${(delta/1000).toFixed(0)}초`
        ]);

        await forceVoiceKick(guild, member);
        await applyPenalty(guild, member, [
          `사유: LIMIT ${LIMIT}분 초과 후 재입장 + GRACE ${Math.round(GRACE*60)}초 경과`,
          `일자: ${dateKey}`
        ]);

        setPenalty.run(now(), dateKey, guild_id, user_id);
        continue;
      }
    }
  }
}

setInterval(() => {
  periodicEnforcer().catch(e => console.error('periodicEnforcer error:', e));
}, CHECK_MS);

// ---------- 부팅 시 세션 정리 & 현재 음성 반영 ----------
client.once('ready', async () => {
  console.log(`Fireworks bot ready as ${client.user.tag}`);

  // 열린 세션(비정상 종료) 정리
  db.exec(`
    UPDATE voice_sessions
       SET leave_ts = COALESCE(leave_ts, ${now()}),
           duration_min = CASE WHEN leave_ts IS NULL THEN (${now()} - join_ts)/60000 ELSE duration_min END
     WHERE leave_ts IS NULL;
  `);

  // 현재 음성 사용자로 새 세션 오픈
  for (const [, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.filter(c => c.isVoiceBased?.());
    for (const [, ch] of channels) {
      for (const [, m] of ch.members) {
        const open = findOpenSes.get(guild.id, m.id);
        if (!open) openSession.run(guild.id, m.id, now());
      }
    }
  }

  // 부팅 즉시 한 번 실행
  periodicEnforcer().catch(()=>{});
});

client.login(DISCORD_TOKEN);

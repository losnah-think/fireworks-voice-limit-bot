require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const Database = require('better-sqlite3');

const {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  MUTE_ROLE_ID,
  DAILY_LIMIT_MINUTES,
  GRACE_MINUTES
} = process.env;

const LIMIT = parseInt(DAILY_LIMIT_MINUTES, 10);
const GRACE = parseInt(GRACE_MINUTES, 10);

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
  grace_until INTEGER,
  penalized_at INTEGER,
  UNIQUE(date_key, guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_user ON daily_usage(user_id, guild_id, date_key);
`);

const upsertDaily = db.prepare(`
INSERT INTO daily_usage (date_key, guild_id, user_id, minutes)
VALUES (@date_key, @guild_id, @user_id, @minutes)
ON CONFLICT(date_key, guild_id, user_id)
DO UPDATE SET minutes = minutes + excluded.minutes
RETURNING *;
`);

const getDaily = db.prepare(`SELECT * FROM daily_usage WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const setWarn = db.prepare(`
UPDATE daily_usage
SET warned_at = ?, grace_until = ?
WHERE date_key = ? AND guild_id = ? AND user_id = ?
`);
const setPenalty = db.prepare(`
UPDATE daily_usage
SET penalized_at = ?
WHERE date_key = ? AND guild_id = ? AND user_id = ?
`);

const openSession = db.prepare(`
INSERT INTO voice_sessions (guild_id, user_id, join_ts) VALUES (?, ?, ?)
`);
const closeSession = db.prepare(`
UPDATE voice_sessions SET leave_ts = ?, duration_min = ?
WHERE id = ?
`);
const findOpenSession = db.prepare(`
SELECT * FROM voice_sessions
WHERE guild_id = ? AND user_id = ? AND leave_ts IS NULL
ORDER BY join_ts DESC LIMIT 1
`);

// ---------- 시간 유틸 ----------
const KST_OFFSET = 9 * 60 * 60 * 1000;
function now() { return Date.now(); }
function todayKSTKey(ts = now()) {
  const k = new Date(ts + KST_OFFSET);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

// ---------- Discord 클라이언트 ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]
});

// 로그 전송
async function sendLog(guild, title, lines = []) {
  try {
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n')).setTimestamp(Date.now());
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error(`로그 전송 실패: ${e.message}`);
  }
}

// 제재 적용
async function applyPenalty(guild, member, reasonLines) {
  const muteRole = guild.roles.cache.get(MUTE_ROLE_ID);
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
    await member.roles.add(muteRole, '2시간 초과 + 유예 종료');
    await sendLog(guild, '⛔ 제재 적용', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `조치: 뮤트 역할 부여`,
      ...reasonLines
    ]);
    await member.send('⛔ 유예 시간이 종료되어 **제재(뮤트)**가 적용되었습니다.').catch(() => {});
    return true;
  } catch (e) {
    console.error(`뮤트 적용 실패: ${e.message}`);
    return false;
  }
}

// 음성 상태 추적
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const member = newState.member || oldState.member;
  if (!guild || !member) return;

  const dateKey = todayKSTKey();

  // 입장
  if (!oldState.channelId && newState.channelId) {
    const open = findOpenSession.get(guild.id, member.id);
    if (!open) openSession.run(guild.id, member.id, now());
    return;
  }

  // 퇴장
  if (oldState.channelId && !newState.channelId) {
    const open = findOpenSession.get(guild.id, member.id);
    if (open) {
      const leave = now();
      const durationMin = (leave - open.join_ts) / 60000;
      closeSession.run(leave, durationMin, open.id);
      upsertDaily.run({
        date_key: dateKey,
        guild_id: guild.id,
        user_id: member.id,
        minutes: durationMin
      });
    }
  }

  // 누적 계산
  const daily = getDaily.get(dateKey, guild.id, member.id);
  let total = daily?.minutes || 0;
  const open = findOpenSession.get(guild.id, member.id);
  if (open) total += (now() - open.join_ts) / 60000;

  // 120분 도달 & 경고 안 함
  if (total >= LIMIT && !(daily?.warned_at)) {
    const warnedAt = now();
    const graceUntil = warnedAt + GRACE * 60 * 1000;
    setWarn.run(warnedAt, graceUntil, dateKey, guild.id, member.id);

    try {
      await member.send(
        `⚠️ **오늘 게임 시간이 ${LIMIT}분을 초과했습니다.**\n` +
        `⏳ 앞으로 **${GRACE}분**의 유예 시간이 주어집니다.\n` +
        `⛔ 유예 종료 시 음성 채널에 계시면 자동 제재가 적용됩니다.`
      );
      await sendLog(guild, '⏳ 유예 시작', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${Math.floor(total)}분`,
        `유예: ${GRACE}분`,
        `채널: ${newState.channel?.name || oldState.channel?.name || 'N/A'}`
      ]);
    } catch {
      await sendLog(guild, '⚠️ DM 전송 실패', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${Math.floor(total)}분`,
        `사유: DM 비활성/차단`
      ]);
    }
  }
});

// 주기 검사(유예 만료/제재)
setInterval(async () => {
  const dateKey = todayKSTKey();
  const rows = db.prepare(`
    SELECT * FROM daily_usage
    WHERE date_key = ? AND warned_at IS NOT NULL AND grace_until IS NOT NULL AND penalized_at IS NULL
  `).all(dateKey);

  for (const row of rows) {
    if (now() < row.grace_until) continue;

    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) continue;

    if (member.voice?.channelId) {
      const ok = await applyPenalty(guild, member, [
        `사유: ${LIMIT}분 초과 + 유예 ${GRACE}분 경과`,
        `일자: ${dateKey}`
      ]);
      if (ok) setPenalty.run(now(), dateKey, row.guild_id, row.user_id);
    } else {
      await sendLog(guild, '✅ 제재 생략', [
        `유저: <@${row.user_id}>`,
        `사유: 유예 종료 시 음성 채널에 없음`,
        `일자: ${dateKey}`
      ]);
      setPenalty.run(now(), dateKey, row.guild_id, row.user_id);
    }
  }
}, 60 * 1000);

// 재시작 시 세션 초기화
client.once('ready', async () => {
  console.log(`Fireworks bot ready as ${client.user.tag}`);
  db.exec(`
    UPDATE voice_sessions
    SET leave_ts = COALESCE(leave_ts, ${now()}), duration_min =
      CASE WHEN leave_ts IS NULL THEN (${now()} - join_ts)/60000 ELSE duration_min END
    WHERE leave_ts IS NULL;
  `);
  for (const [, guild] of client.guilds.cache) {
    const channels = guild.channels.cache.filter(c => c.isVoiceBased?.());
    for (const [, ch] of channels) {
      for (const [, m] of ch.members) {
        const open = findOpenSession.get(guild.id, m.id);
        if (!open) openSession.run(guild.id, m.id, now());
      }
    }
  }
});

client.login(DISCORD_TOKEN);

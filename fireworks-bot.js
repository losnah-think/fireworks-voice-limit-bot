require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const Database = require('better-sqlite3');

const {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  MUTE_ROLE_ID,
  DAILY_LIMIT_MINUTES,  // ex) 1
  GRACE_MINUTES,        // ex) 0.5 (30초)
  CHECK_INTERVAL_SECONDS // (옵션) 기본 5초
} = process.env;

// ✅ 소수점 분 지원 (0.5분 = 30초)
const LIMIT = parseFloat(DAILY_LIMIT_MINUTES || '120');
const GRACE = parseFloat(GRACE_MINUTES || '30');
const CHECK_MS = parseInt(CHECK_INTERVAL_SECONDS || '5', 10) * 1000;

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

const getDaily     = db.prepare(`SELECT * FROM daily_usage WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const setWarn      = db.prepare(`UPDATE daily_usage SET warned_at = ?, grace_until = ? WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const setPenalty   = db.prepare(`UPDATE daily_usage SET penalized_at = ? WHERE date_key = ? AND guild_id = ? AND user_id = ?`);
const openSession  = db.prepare(`INSERT INTO voice_sessions (guild_id, user_id, join_ts) VALUES (?, ?, ?)`);
const closeSession = db.prepare(`UPDATE voice_sessions SET leave_ts = ?, duration_min = ? WHERE id = ?`);
const findOpenSession = db.prepare(`
SELECT * FROM voice_sessions
WHERE guild_id = ? AND user_id = ? AND leave_ts IS NULL
ORDER BY join_ts DESC LIMIT 1
`);

// ---------- 시간 유틸 ----------
const KST_OFFSET = 9 * 60 * 60 * 1000;
const now = () => Date.now();
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

// 제재 적용(역할 부여)
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
    await member.roles.add(muteRole, `Daily limit ${LIMIT}m exceeded; grace ${GRACE}m ended`);
    await sendLog(guild, '⛔ 제재 적용', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `조치: 뮤트 역할 부여`,
      ...reasonLines
    ]);
    // DM 통지(실패 무시)
    await member.send('⛔ 유예 시간이 종료되어 **제재(뮤트)**가 적용되었습니다.').catch(()=>{});
    return true;
  } catch (e) {
    console.error(`뮤트 적용 실패: ${e.message}`);
    await sendLog(guild, '⚠️ 제재 실패', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `사유: 역할 부여 실패(권한/위계 확인 필요)`
    ]);
    return false;
  }
}

// 음성 상태 추적
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild  = newState.guild || oldState.guild;
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

  // 누적 계산(진행 중 포함)
  const daily = getDaily.get(dateKey, guild.id, member.id);
  let total = daily?.minutes || 0;
  const open = findOpenSession.get(guild.id, member.id);
  if (open) total += (now() - open.join_ts) / 60000;

  // ⏰ 제한 도달 & 아직 경고 안 함 → DM + 로그 + 음성 퇴장 + 유예 타이머 기록
  if (total >= LIMIT && !(daily?.warned_at)) {
    const warnedAt   = now();
    const graceUntil = warnedAt + GRACE * 60 * 1000; // GRACE 분 → ms
    setWarn.run(warnedAt, graceUntil, dateKey, guild.id, member.id);

    // 경고 DM
    try {
      const secs = Math.round(GRACE * 60);
      await member.send(
        `⚠️ **오늘 게임 시간이 ${LIMIT}분을 초과했습니다.**\n` +
        `⏳ 앞으로 **${secs}초**의 유예 시간이 주어집니다.\n` +
        `⛔ 유예 종료 후 역할이 변경되어 제재가 적용됩니다.`
      );
    } catch {
      await sendLog(guild, '⚠️ DM 전송 실패', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `누적: ${total.toFixed(1)}분`,
        `사유: DM 비활성/차단`
      ]);
    }

    // 로그
    await sendLog(guild, '⚠️ 경고 발송 및 음성 채널 강제 퇴장', [
      `유저: <@${member.id}> (${member.user.tag})`,
      `누적: ${total.toFixed(1)}분`,
      `유예: ${(GRACE*60).toFixed(0)}초`,
      `채널: ${newState.channel?.name || oldState.channel?.name || 'N/A'}`
    ]);

    // 🔌 음성 채널 강제 퇴장(권한 필요: Move Members)
    try {
      if (member.voice?.channelId) {
        await member.voice.disconnect('Daily limit reached: warning kick from voice');
      }
    } catch (e) {
      await sendLog(guild, '⚠️ 음성 강제 퇴장 실패', [
        `유저: <@${member.id}> (${member.user.tag})`,
        `사유: 권한 부족(Need Move Members) 또는 일시적 오류`
      ]);
    }
  }
});

// ⏱️ 주기 검사(유예 만료 → 역할 변경). 테스트 대응: 기본 5초 간격
setInterval(async () => {
  const dateKey = todayKSTKey();
  const rows = db.prepare(`
    SELECT * FROM daily_usage
    WHERE date_key = ?
      AND warned_at IS NOT NULL
      AND grace_until IS NOT NULL
      AND penalized_at IS NULL
  `).all(dateKey);

  for (const row of rows) {
    if (now() < row.grace_until) continue;

    const guild  = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) continue;

    // 요구사항: 유예 시간 경과 시 **역할 변경(무조건 적용)**
    const ok = await applyPenalty(guild, member, [
      `사유: ${LIMIT}분 초과 + 유예 ${Math.round(GRACE*60)}초 경과`,
      `일자: ${dateKey}`
    ]);
    // 재검 방지 마킹
    if (ok) setPenalty.run(now(), dateKey, row.guild_id, row.user_id);
    else    setPenalty.run(now(), dateKey, row.guild_id, row.user_id); // 실패해도 중복 시도 방지(원하면 제거)
  }
}, CHECK_MS);

// 재시작 시 세션 초기화 & 현재 음성 사용자 반영
client.once('ready', async () => {
  console.log(`Fireworks bot ready as ${client.user.tag}`);

  db.exec(`
    UPDATE voice_sessions
       SET leave_ts = COALESCE(leave_ts, ${now()}),
           duration_min = CASE WHEN leave_ts IS NULL THEN (${now()} - join_ts)/60000 ELSE duration_min END
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

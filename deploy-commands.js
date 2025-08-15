// deploy-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('time_check')
    .setDescription('특정 유저의 현재 누적 시간과 남은 시간 확인')
    .addUserOption(o => o.setName('user').setDescription('확인할 유저').setRequired(true)),
  new SlashCommandBuilder()
    .setName('time_add')
    .setDescription('특정 유저의 사용 가능 시간을 추가(리밋 보너스)')
    .addUserOption(o => o.setName('user').setDescription('시간을 추가할 유저').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('추가할 시간(분, 기본 60)').setRequired(false)),
].map(c => c.toJSON());

const { DISCORD_TOKEN, CLIENT_ID } = process.env;

(async () => {
  try {
    console.log('💾 글로벌 명령어 등록 중...');
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ 명령어 등록 완료');
  } catch (e) {
    console.error('❌ 명령어 등록 실패:', e);
    process.exit(1);
  }
})();

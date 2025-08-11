// setup.js (CommonJS)
require('dotenv').config();
const {
  Client, GatewayIntentBits, ChannelType,
  PermissionFlagsBits, PermissionsBitField, EmbedBuilder
} = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) { console.log('No guild found'); process.exit(1); }

    // 1) 역할 만들기 (permissions 없는 역할은 필드 자체를 생략)
    const wantRoles = [
      { name: '관리자', perms: PermissionFlagsBits.Administrator },
      { name: '부관리자', perms: PermissionFlagsBits.ManageGuild
        | PermissionFlagsBits.ManageMessages
        | PermissionFlagsBits.ModerateMembers },
      { name: '멤버' }, // perms 생략
      { name: '뮤트' }  // perms 생략
    ];
    const roles = {};
    for (const r of wantRoles) {
      let role = guild.roles.cache.find(x => x.name === r.name);
      if (!role) {
        const createOpts = { name: r.name };
        if (typeof r.perms !== 'undefined') createOpts.permissions = r.perms;
        role = await guild.roles.create(createOpts);
      }
      roles[r.name] = role;
    }

    // 2) 카테고리
    const cats = {};
    async function mkCat(name) {
      let c = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === name);
      if (!c) c = await guild.channels.create({ name, type: ChannelType.GuildCategory });
      cats[name] = c; return c;
    }

    const catStats = await mkCat('📊 SERVER STATS');
    const catNew   = await mkCat('🆕 NEW');
    const catGames = await mkCat('🎮 GAMES');
    const catComm  = await mkCat('💬 COMMUNITY');
    const catStaff = await mkCat('🛡 STAFF');

    // 3) 채널 유틸
    async function mkText(name, parent, opts = {}) {
      let ch = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name === name);
      if (!ch) ch = await guild.channels.create({
        name, type: ChannelType.GuildText, parent: parent.id, ...opts
      });
      return ch;
    }
    async function mkVoice(name, parent) {
      let ch = guild.channels.cache.find(ch => ch.type === ChannelType.GuildVoice && ch.name === name);
      if (!ch) ch = await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: parent.id });
      return ch;
    }

    // 4) 통계 자리
    await mkText('all-members', catStats);
    await mkText('members', catStats);
    await mkText('bots', catStats);
    await mkText('channels', catStats);
    await mkText('roles', catStats);

    // 5) NEW
    const chWelcome = await mkText('welcome', catNew);
    const chNotice  = await mkText('공지사항', catNew);
    await mkText('자기소개', catNew);

    // 6) COMMUNITY / GAMES
    await mkText('잡담', catComm);
    await mkText('건의사항', catComm);
    await mkText('이벤트참여', catComm);

    await mkText('게임잡담', catGames);
    await mkText('게임팁', catGames);
    await mkText('파티모집', catGames);
    await mkVoice('게임방-1', catGames);
    await mkVoice('게임방-2', catGames);
    await mkVoice('자유음성', catGames);

    // 7) STAFF (운영진만 보기)
    const staffOpts = {
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: roles['관리자'].id,    allow: [PermissionsBitField.Flags.ViewChannel] },
        { id: roles['부관리자'].id,  allow: [PermissionsBitField.Flags.ViewChannel] }
      ]
    };
    await mkText('관리공지', catStaff, staffOpts);
    await mkText('신고접수', catStaff, staffOpts);
    await mkText('서버-로그', catStaff, staffOpts);

    // 8) 공지/환영 Embed
    const rules = [
      '미클자와의 친구추가는 가능하나 노미클자와의 친구추가는 불가능합니다.',
      '게임 중 과한 한숨/욕설 등 다른 멤버의 기분을 상하게 하는 경우 경고입니다.',
      '건의사항은 방장 또는 관리자에게 개인 DM로 보내주세요.',
      '채널 주제에 맞게 사용해주세요.',
      '인원수를 억지로 맞춰 게임하는 행위 금지 (사람이 많으면 나눠서 진행).',
      '여기는 게임방이지만, 공창/음성 채널에서도 활발히 활동 부탁드립니다.'
    ];
    const notice = new EmbedBuilder()
      .setTitle('📢 Fireworks 서버 공지/규칙 (필독)')
      .setDescription('읽지 않고 발생하는 모든 불이익은 본인 책임입니다.\n\n' + rules.map((r,i)=>`**${i+1}.** ${r}`).join('\n'))
      .setColor(0xff6b6b);
    await chNotice.send({ embeds: [notice] });

    const welcome = new EmbedBuilder()
      .setTitle('🎉 환영합니다!')
      .setDescription('여기는 **Fireworks** 커뮤니티입니다. `#자기소개`에서 인사하고, `#공지사항`을 먼저 읽어주세요!')
      .setColor(0x00c2ff);
    await chWelcome.send({ embeds: [welcome] });

    console.log('Setup completed');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);

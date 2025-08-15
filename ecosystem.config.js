// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "fireworks-bot",
      script: "./fireworks-bot.js",   // 파일명 유지
      cwd: "/srv/fireworks",          // ← 프로젝트 경로로 바꿔주세요 (예: /srv/fireworks)
      instances: 1,                   // SQLite 사용 → 단일 인스턴스 권장
      exec_mode: "fork",
      watch: false,                   // 코드 변경 자동 재시작 필요하면 true
      // 감시할 필요 없는 경로 (watch 사용 시에만 의미)
      ignore_watch: ["logs", "*.db", "node_modules"],

      // 재시작/안정성
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 5000,

      // 로그
      time: true,                     // pm2 logs에 타임스탬프
      error_file: "/srv/fireworks/logs/err.log",
      out_file: "/srv/fireworks/logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // 환경변수
      env: {
        NODE_ENV: "production",
        // 아래 두 항목은 선택사항입니다. 사용 시 주석 해제하세요.
        // REGISTER_COMMANDS_ON_BOOT: "0",   // 1이면 부팅 시 슬래시 커맨드 자동 등록
        // DB_PATH: "/srv/fireworks/fireworks.db"
      }
      // env_production: { ... } // 필요하면 분리 사용
    }
  ]
};

import { runChecks } from './tools/deps-check/check.mjs';
for (let i=0;i<3;i++){const t=performance.now();const r=runChecks(process.cwd());console.log(r.files,'files',Math.round(performance.now()-t),'ms');}

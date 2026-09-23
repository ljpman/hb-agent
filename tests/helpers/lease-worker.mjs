import { Store } from '../../server/store.mjs';
import { Service } from '../../server/service.mjs';

const store = new Store(process.argv[2]);
let release;
const service = new Service(store, { stepMs: 0, pdf: async () => {
  process.send('render');
  await new Promise(resolve => { release = resolve; });
  return Buffer.from('%PDF-process-test');
} });
process.on('message', async message => {
  if (message === 'tick') { await service.tick(); process.send('done'); }
  if (message === 'release') release?.();
});
process.send('ready');

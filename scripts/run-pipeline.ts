import 'dotenv/config';
import { runPipeline } from '../src/lib/pipeline';

runPipeline().catch((e) => {
  console.error(e);
  process.exit(1);
});

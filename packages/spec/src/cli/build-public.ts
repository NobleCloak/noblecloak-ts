import { buildPublic } from '../spec/public-file.js';

try {
  console.log(`document written: ${buildPublic()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

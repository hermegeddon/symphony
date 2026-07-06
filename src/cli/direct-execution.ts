import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isDirectCliExecution(importMetaUrl: string, argvPath: string | undefined = process.argv[1]): boolean {
  if (argvPath === undefined || argvPath.length === 0) {
    return false;
  }

  if (pathToFileURL(argvPath).href === importMetaUrl) {
    return true;
  }

  try {
    return pathToFileURL(realpathSync(argvPath)).href === importMetaUrl;
  } catch {
    return false;
  }
}

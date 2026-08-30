import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { pathToFileURL } from 'node:url';

import { requireSecret } from './lib/env.js';
import { deploymentRoute } from './runtime/deployment.js';
import { publicCommandData } from './runtime/public.js';

export async function deployCommands({
  environment = process.env,
  rest = new REST(),
  routes = Routes,
} = {}) {
  const commands = publicCommandData().map((command) => command.toJSON());

  rest.setToken(requireSecret('DISCORD_TOKEN', environment));
  const route = deploymentRoute(environment, routes);
  await rest.put(route, { body: commands });

  return {
    count: commands.length,
    scope: environment.PUBLIC_STAGING_GUILD_ID?.trim() ? 'guild' : 'global',
  };
}

async function runCli() {
  try {
    console.log('公開Botのスラッシュコマンドを登録中...');
    const result = await deployCommands();
    console.log(`✅ ${result.count} 個のコマンドを${result.scope}へ登録しました`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCli();

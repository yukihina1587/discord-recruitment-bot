function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value || !/^\d{17,20}$/.test(value)) {
    throw new Error(`${name} must be a 17-20 digit Discord id`);
  }
  return value;
}

export function deploymentRoute(environment, routes) {
  const clientId = required(environment, 'CLIENT_ID');
  const stagingGuildId = environment.PUBLIC_STAGING_GUILD_ID?.trim();
  return stagingGuildId
    ? routes.applicationGuildCommands(
        clientId,
        required(environment, 'PUBLIC_STAGING_GUILD_ID'),
      )
    : routes.applicationCommands(clientId);
}

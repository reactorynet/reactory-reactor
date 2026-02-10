import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Reactory from '@reactory/reactory-core';
import { Macro, MacroComponentDefinition, ChatState, MacroToolDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import ReactoryClientModel from "@reactory/server-modules/reactory-core/models/ReactoryClient";
import logger from "@reactory/server-core/logging";

const {
  APPLICATION_ROOT = 'src',
} = process.env;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the clientConfigs folder.
 */
const getClientConfigsDir = () =>
  path.resolve(process.cwd(), APPLICATION_ROOT, 'data/clientConfigs');

/**
 * Ensures a directory exists, creating it recursively if needed.
 */
const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

/**
 * Writes a YAML file to disk.
 */
const writeYaml = (filePath: string, data: unknown) => {
  ensureDir(path.dirname(filePath));
  const yamlContent = yaml.dump(data, { lineWidth: 120, noRefs: true, sortKeys: false });
  fs.writeFileSync(filePath, yamlContent, 'utf8');
};

/**
 * Returns the user's personal working folder for app definitions.
 * Falls back to $APP_DATA_ROOT/profiles/{userId}/.reactory/apps if available.
 */
const getUserWorkingDir = (context: Reactory.Server.IReactoryContext): string => {
  const home = process.env.APP_DATA_ROOT || '/tmp';
  const workingDir = path.join(home, 'profiles', context.user.id, '.reactory', 'apps');
  ensureDir(workingDir);
  return workingDir;
};

/**
 * Serialises the minimal client config object that we write to YAML.
 */
const toYamlConfig = (config: Partial<Reactory.Server.IReactoryClientConfig>): Record<string, unknown> => {
  // Strip Mongoose internals and methods, keep only plain data
  const plain: Record<string, unknown> = {};
  const allowedKeys = [
    'key', 'name', 'username', 'email', 'salt', 'password',
    'siteUrl', 'avatar', 'emailSendVia', 'emailApiKey', 'resetEmailRoute',
    'applicationRoles', 'billingType', 'theme', 'allowCustomTheme',
    'whitelist',
  ];
  for (const k of allowedKeys) {
    if ((config as any)[k] !== undefined) plain[k] = (config as any)[k];
  }
  return plain;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: createApplication
// ─────────────────────────────────────────────────────────────────────────────

type CreateApplicationParams = {
  key: string;
  name: string;
  username?: string;
  email?: string;
  siteUrl?: string;
  applicationRoles?: string[];
  billingType?: string;
  theme?: string;
  allowCustomTheme?: boolean;
  whitelist?: string[];
  saveTo?: 'personal' | 'provision' | 'both';
};

const CreateApplication: Macro<any, CreateApplicationParams> = async (
  params,
  chatState,
  context,
) => {
  const {
    key,
    name,
    username,
    email,
    siteUrl = 'http://localhost:3000',
    applicationRoles = ['USER', 'ANON'],
    billingType = 'free',
    theme,
    allowCustomTheme = false,
    whitelist = ['localhost'],
    saveTo = 'personal',
  } = params;

  if (!key || !name) {
    return {
      success: false,
      error: 'Missing required parameters: key and name are required to create a new application definition.',
      tool: 'createApplication',
      params,
    };
  }

  try {
    // Check if it already exists in the database
    const existing = await ReactoryClientModel.findOne({ key });
    if (existing) {
      return {
        success: false,
        error: `An application with key "${key}" already exists (id: ${existing._id}). Use updateApplication* tools to modify it.`,
        tool: 'createApplication',
        params,
      };
    }

    const newConfig: Partial<Reactory.Server.IReactoryClientConfig> = {
      key,
      name,
      username: username || key,
      email: email || `${key}@reactory.net`,
      salt: 'generate',
      password: `${key}-secret`,
      siteUrl,
      avatar: '',
      emailSendVia: 'sendgrid',
      emailApiKey: 'SG.disabled',
      resetEmailRoute: '/forgot-password',
      applicationRoles,
      billingType,
      theme: theme || key,
      allowCustomTheme,
      whitelist,
      menus: [],
      routes: [],
      themes: [],
      settings: [],
      auth_config: [],
      plugins: [],
    };

    // Upsert into Mongo via the model statics
    // @ts-ignore – statics are available on the model
    const clientDoc = await ReactoryClientModel.upsertFromConfig(newConfig, context);

    // Write YAML files based on saveTo preference
    const filesWritten: string[] = [];

    const yamlData = toYamlConfig(newConfig);

    if (saveTo === 'personal' || saveTo === 'both') {
      const personalDir = path.join(getUserWorkingDir(context), key);
      const personalPath = path.join(personalDir, 'config.yaml');
      writeYaml(personalPath, yamlData);
      filesWritten.push(personalPath);
    }

    if (saveTo === 'provision' || saveTo === 'both') {
      const provisionDir = path.join(getClientConfigsDir(), key);
      const provisionPath = path.join(provisionDir, 'config.yaml');
      writeYaml(provisionPath, yamlData);
      filesWritten.push(provisionPath);

      // Also add to enabled-clients if not present
      const enabledFile = path.join(getClientConfigsDir(), 'enabled-clients.reactory.json');
      if (fs.existsSync(enabledFile)) {
        const enabledClients: string[] = JSON.parse(fs.readFileSync(enabledFile, 'utf8'));
        if (!enabledClients.includes(key)) {
          enabledClients.push(key);
          fs.writeFileSync(enabledFile, JSON.stringify(enabledClients, null, 2), 'utf8');
          filesWritten.push(enabledFile);
        }
      }
    }

    // Store in chat state
    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastCreatedApplication = newConfig;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Application "${name}" (key: ${key}) created successfully.`,
          action: 'created',
          clientId: clientDoc?._id?.toString(),
          saveTo,
          filesWritten,
        },
        application: yamlData,
      },
      tool: 'createApplication',
      params,
      format: 'json',
      instructions: `
## Application Created

A new Reactory application definition has been created.

### Details:
- **Key**: ${key}
- **Name**: ${name}
- **Site URL**: ${siteUrl}
- **Roles**: ${applicationRoles.join(', ')}
- **Billing**: ${billingType}
- **Saved To**: ${saveTo}
- **Files Written**: ${filesWritten.length > 0 ? filesWritten.map(f => `\n  - ${f}`).join('') : 'Database only'}

### State Variables:
- lastCreatedApplication: The full application config object
- lastApplicationKey: "${key}"

### Next Steps:
You can now use the following tools to configure this application further:
- **updateApplicationThemes** – add or modify theme palettes
- **updateApplicationRoutes** – define URL routes and their components
- **updateApplicationSettings** – configure application settings
- **updateApplicationAuth** – set up authentication providers
- **updateApplicationPlugins** – register client-side plugins
- **updateApplicationMenus** – define navigation menus
- **getApplication** – retrieve the current state of the application
      `,
    };
  } catch (error: any) {
    logger.error('Error in createApplication macro', { error, params });
    return {
      success: false,
      error: `Failed to create application: ${error?.message || 'Unknown error'}`,
      tool: 'createApplication',
      params,
    };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: getApplication
// ─────────────────────────────────────────────────────────────────────────────

type GetApplicationParams = {
  key: string;
  format?: 'json' | 'yaml' | 'summary';
};

const GetApplication: Macro<any, GetApplicationParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, format = 'json' } = params;

  if (!key) {
    return { success: false, error: 'Missing required parameter: key', tool: 'getApplication', params };
  }

  try {
    const client = await ReactoryClientModel.findOne({ key }).lean();
    if (!client) {
      return {
        success: false,
        error: `Application with key "${key}" not found.`,
        tool: 'getApplication',
        params,
      };
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastRetrievedApplication = client;
    chatState.vars.lastApplicationKey = key;

    let output: unknown;
    switch (format) {
      case 'yaml':
        output = yaml.dump(client, { lineWidth: 120, noRefs: true, sortKeys: false });
        break;
      case 'summary':
        output = {
          key: client.key,
          name: client.name,
          siteUrl: (client as any).siteUrl,
          applicationRoles: (client as any).applicationRoles,
          themeCount: ((client as any).themes || []).length,
          routeCount: ((client as any).routes || []).length,
          menuCount: ((client as any).menus || []).length,
          pluginCount: ((client as any).plugins || []).length,
          settingsCount: ((client as any).settings || []).length,
          whitelist: (client as any).whitelist,
        };
        break;
      default:
        output = client;
    }

    return {
      success: true,
      data: output,
      tool: 'getApplication',
      params,
      format,
      instructions: `
## Application Retrieved: ${client.name}

- **Key**: ${client.key}
- **Name**: ${client.name}
- **Themes**: ${((client as any).themes || []).length} defined
- **Routes**: ${((client as any).routes || []).length} defined
- **Menus**: ${((client as any).menus || []).length} defined
- **Plugins**: ${((client as any).plugins || []).length} registered
- **Settings**: ${((client as any).settings || []).length} configured

### State Variables:
- lastRetrievedApplication: The retrieved application document
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in getApplication macro', { error, params });
    return { success: false, error: `Failed to retrieve application: ${error?.message || 'Unknown error'}`, tool: 'getApplication', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: listApplications
// ─────────────────────────────────────────────────────────────────────────────

type ListApplicationsParams = {
  format?: 'json' | 'markdown' | 'summary';
};

const ListApplications: Macro<any, ListApplicationsParams> = async (
  params,
  chatState,
  context,
) => {
  const { format = 'summary' } = params || {};

  try {
    const clients = await ReactoryClientModel.find({}, 'key name siteUrl applicationRoles billingType theme').lean();

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.listedApplications = clients;

    let output: unknown;
    switch (format) {
      case 'markdown': {
        const header = '| Key | Name | Site URL | Billing |\n|-----|------|----------|---------|\n';
        const rows = clients.map((c: any) => `| ${c.key} | ${c.name} | ${c.siteUrl || ''} | ${c.billingType || ''} |`).join('\n');
        output = header + rows;
        break;
      }
      case 'summary':
        output = clients.map((c: any) => ({ key: c.key, name: c.name, siteUrl: c.siteUrl, billingType: c.billingType }));
        break;
      default:
        output = clients;
    }

    return {
      success: true,
      data: { applications: output, total: clients.length },
      tool: 'listApplications',
      params,
      format,
      instructions: `
## Application Listing

Found ${clients.length} registered applications.

${clients.map((c: any) => `- **${c.name}** (key: \`${c.key}\`)`).join('\n')}

### State Variables:
- listedApplications: Array of all application summaries
      `,
    };
  } catch (error: any) {
    logger.error('Error in listApplications macro', { error });
    return { success: false, error: `Failed to list applications: ${error?.message || 'Unknown error'}`, tool: 'listApplications', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: updateApplicationThemes
// ─────────────────────────────────────────────────────────────────────────────

type UpdateApplicationThemesParams = {
  key: string;
  themes: Reactory.UX.IReactoryTheme[];
  persist?: boolean;
  saveTo?: 'database' | 'yaml' | 'both';
};

const UpdateApplicationThemes: Macro<any, UpdateApplicationThemesParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, themes, persist = true, saveTo = 'both' } = params;

  if (!key || !themes) {
    return { success: false, error: 'Missing required parameters: key and themes are required.', tool: 'updateApplicationThemes', params };
  }

  try {
    let clientDoc: any = null;

    if (persist && (saveTo === 'database' || saveTo === 'both')) {
      clientDoc = await ReactoryClientModel.findOne({ key });
      if (!clientDoc) {
        return { success: false, error: `Application "${key}" not found in database.`, tool: 'updateApplicationThemes', params };
      }
      clientDoc.themes = themes;
      clientDoc.markModified('themes');
      await clientDoc.save();
    }

    const filesWritten: string[] = [];
    if (saveTo === 'yaml' || saveTo === 'both') {
      const configDir = path.join(getClientConfigsDir(), key);
      if (fs.existsSync(configDir)) {
        const themePath = path.join(configDir, 'themes.yaml');
        writeYaml(themePath, themes);
        filesWritten.push(themePath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastUpdatedThemes = themes;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Updated ${themes.length} theme(s) for application "${key}".`,
          themeNames: themes.map((t: any) => t.name),
          saveTo,
          filesWritten,
        },
        themes,
      },
      tool: 'updateApplicationThemes',
      params,
      format: 'json',
      instructions: `
## Themes Updated for "${key}"

Successfully updated ${themes.length} theme definition(s).
${themes.map((t: any) => `- **${t.name}**: ${t.description || 'No description'} (modes: ${(t.modes || []).map((m: any) => m.mode).join(', ')})`).join('\n')}

### Saved To:
${saveTo === 'database' || saveTo === 'both' ? '- Database (MongoDB)' : ''}
${filesWritten.length > 0 ? filesWritten.map(f => `- File: ${f}`).join('\n') : ''}

### State Variables:
- lastUpdatedThemes: The theme definitions that were saved
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in updateApplicationThemes macro', { error, params });
    return { success: false, error: `Failed to update themes: ${error?.message || 'Unknown error'}`, tool: 'updateApplicationThemes', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: updateApplicationRoutes
// ─────────────────────────────────────────────────────────────────────────────

type UpdateApplicationRoutesParams = {
  key: string;
  routes: Array<{
    key: string;
    title: string;
    path: string;
    public?: boolean;
    roles?: string[];
    exact?: boolean;
    componentFqn?: string;
    redirect?: string;
    args?: unknown[];
    componentProps?: Record<string, unknown>;
  }>;
  saveTo?: 'database' | 'yaml' | 'both';
};

const UpdateApplicationRoutes: Macro<any, UpdateApplicationRoutesParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, routes, saveTo = 'both' } = params;

  if (!key || !routes) {
    return { success: false, error: 'Missing required parameters: key and routes are required.', tool: 'updateApplicationRoutes', params };
  }

  try {
    let clientDoc: any = null;

    if (saveTo === 'database' || saveTo === 'both') {
      // Use upsertFromConfig so routes get the full synchronisation treatment
      // @ts-ignore
      clientDoc = await ReactoryClientModel.upsertFromConfig({ key, routes }, context);
      if (!clientDoc) {
        return { success: false, error: `Application "${key}" not found.`, tool: 'updateApplicationRoutes', params };
      }
    }

    const filesWritten: string[] = [];
    if (saveTo === 'yaml' || saveTo === 'both') {
      const configDir = path.join(getClientConfigsDir(), key);
      if (fs.existsSync(configDir)) {
        const routesPath = path.join(configDir, 'routes.yaml');
        writeYaml(routesPath, routes);
        filesWritten.push(routesPath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastUpdatedRoutes = routes;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Synchronized ${routes.length} route(s) for application "${key}".`,
          routePaths: routes.map(r => r.path),
          saveTo,
          filesWritten,
        },
        routes,
      },
      tool: 'updateApplicationRoutes',
      params,
      format: 'json',
      instructions: `
## Routes Updated for "${key}"

Successfully synchronised ${routes.length} route(s):
${routes.map(r => `- **${r.title || r.key}** → \`${r.path}\` (${r.public ? 'public' : 'protected'})`).join('\n')}

### State Variables:
- lastUpdatedRoutes: The route definitions that were saved
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in updateApplicationRoutes macro', { error, params });
    return { success: false, error: `Failed to update routes: ${error?.message || 'Unknown error'}`, tool: 'updateApplicationRoutes', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: updateApplicationSettings
// ─────────────────────────────────────────────────────────────────────────────

type UpdateApplicationSettingsParams = {
  key: string;
  settings: Array<{
    name: string;
    settingType?: string;
    variant?: string;
    title?: string;
    description?: string;
    componentFqn?: string;
    formSchema?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }>;
  saveTo?: 'database' | 'yaml' | 'both';
};

const UpdateApplicationSettings: Macro<any, UpdateApplicationSettingsParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, settings, saveTo = 'both' } = params;

  if (!key || !settings) {
    return { success: false, error: 'Missing required parameters: key and settings are required.', tool: 'updateApplicationSettings', params };
  }

  try {
    if (saveTo === 'database' || saveTo === 'both') {
      const clientDoc = await ReactoryClientModel.findOne({ key });
      if (!clientDoc) {
        return { success: false, error: `Application "${key}" not found.`, tool: 'updateApplicationSettings', params };
      }
      (clientDoc as any).settings = settings;
      clientDoc.markModified('settings');
      await clientDoc.save();
    }

    const filesWritten: string[] = [];
    if (saveTo === 'yaml' || saveTo === 'both') {
      const configDir = path.join(getClientConfigsDir(), key);
      if (fs.existsSync(configDir)) {
        const settingsPath = path.join(configDir, 'settings.yaml');
        writeYaml(settingsPath, settings);
        filesWritten.push(settingsPath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastUpdatedSettings = settings;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Updated ${settings.length} setting(s) for application "${key}".`,
          settingNames: settings.map(s => s.name),
          saveTo,
          filesWritten,
        },
        settings,
      },
      tool: 'updateApplicationSettings',
      params,
      format: 'json',
      instructions: `
## Settings Updated for "${key}"

Successfully updated ${settings.length} setting(s):
${settings.map(s => `- **${s.name}**: ${s.title || s.description || 'No description'}`).join('\n')}

### State Variables:
- lastUpdatedSettings: The setting definitions
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in updateApplicationSettings macro', { error, params });
    return { success: false, error: `Failed to update settings: ${error?.message || 'Unknown error'}`, tool: 'updateApplicationSettings', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: updateApplicationAuth
// ─────────────────────────────────────────────────────────────────────────────

type UpdateApplicationAuthParams = {
  key: string;
  auth_config: Array<{
    provider: string;
    enabled: boolean;
    properties?: Record<string, unknown>;
  }>;
  saveTo?: 'database' | 'yaml' | 'both';
};

const UpdateApplicationAuth: Macro<any, UpdateApplicationAuthParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, auth_config, saveTo = 'both' } = params;

  if (!key || !auth_config) {
    return { success: false, error: 'Missing required parameters: key and auth_config are required.', tool: 'updateApplicationAuth', params };
  }

  try {
    if (saveTo === 'database' || saveTo === 'both') {
      const clientDoc = await ReactoryClientModel.findOne({ key });
      if (!clientDoc) {
        return { success: false, error: `Application "${key}" not found.`, tool: 'updateApplicationAuth', params };
      }
      (clientDoc as any).auth_config = auth_config;
      clientDoc.markModified('auth_config');
      await clientDoc.save();
    }

    const filesWritten: string[] = [];
    if (saveTo === 'yaml' || saveTo === 'both') {
      const configDir = path.join(getClientConfigsDir(), key);
      if (fs.existsSync(configDir)) {
        const authPath = path.join(configDir, 'authentication/auth-config.yaml');
        writeYaml(authPath, auth_config);
        filesWritten.push(authPath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastUpdatedAuthConfig = auth_config;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Updated ${auth_config.length} auth provider(s) for application "${key}".`,
          providers: auth_config.map(a => `${a.provider} (${a.enabled ? 'enabled' : 'disabled'})`),
          saveTo,
          filesWritten,
        },
        auth_config,
      },
      tool: 'updateApplicationAuth',
      params,
      format: 'json',
      instructions: `
## Auth Config Updated for "${key}"

Successfully updated ${auth_config.length} authentication provider(s):
${auth_config.map(a => `- **${a.provider}**: ${a.enabled ? 'Enabled' : 'Disabled'}`).join('\n')}

### State Variables:
- lastUpdatedAuthConfig: The auth configurations
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in updateApplicationAuth macro', { error, params });
    return { success: false, error: `Failed to update auth config: ${error?.message || 'Unknown error'}`, tool: 'updateApplicationAuth', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: updateApplicationPlugins
// ─────────────────────────────────────────────────────────────────────────────

type UpdateApplicationPluginsParams = {
  key: string;
  plugins: Array<{
    name: string;
    nameSpace?: string;
    version?: string;
    description?: string;
    platform?: string;
    uri?: string;
    loader?: string;
    enabled?: boolean;
    roles?: string[];
  }>;
  saveTo?: 'database' | 'yaml' | 'both';
};

const UpdateApplicationPlugins: Macro<any, UpdateApplicationPluginsParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, plugins, saveTo = 'both' } = params;

  if (!key || !plugins) {
    return { success: false, error: 'Missing required parameters: key and plugins are required.', tool: 'updateApplicationPlugins', params };
  }

  try {
    if (saveTo === 'database' || saveTo === 'both') {
      const clientDoc = await ReactoryClientModel.findOne({ key });
      if (!clientDoc) {
        return { success: false, error: `Application "${key}" not found.`, tool: 'updateApplicationPlugins', params };
      }
      (clientDoc as any).plugins = plugins;
      clientDoc.markModified('plugins');
      await clientDoc.save();
    }

    const filesWritten: string[] = [];
    if (saveTo === 'yaml' || saveTo === 'both') {
      const configDir = path.join(getClientConfigsDir(), key);
      if (fs.existsSync(configDir)) {
        const pluginsPath = path.join(configDir, 'plugins.yaml');
        writeYaml(pluginsPath, plugins);
        filesWritten.push(pluginsPath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastUpdatedPlugins = plugins;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Updated ${plugins.length} plugin(s) for application "${key}".`,
          pluginNames: plugins.map(p => `${p.nameSpace || ''}${p.nameSpace ? '.' : ''}${p.name}@${p.version || 'latest'}`),
          saveTo,
          filesWritten,
        },
        plugins,
      },
      tool: 'updateApplicationPlugins',
      params,
      format: 'json',
      instructions: `
## Plugins Updated for "${key}"

Successfully updated ${plugins.length} plugin(s):
${plugins.map(p => `- **${p.name}** (${p.enabled !== false ? 'enabled' : 'disabled'}) – ${p.description || 'No description'}`).join('\n')}

### State Variables:
- lastUpdatedPlugins: The plugin definitions
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in updateApplicationPlugins macro', { error, params });
    return { success: false, error: `Failed to update plugins: ${error?.message || 'Unknown error'}`, tool: 'updateApplicationPlugins', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: updateApplicationMenus
// ─────────────────────────────────────────────────────────────────────────────

type UpdateApplicationMenusParams = {
  key: string;
  menus: Array<{
    key: string;
    name?: string;
    target?: string;
    roles?: string[];
    entries?: Array<{
      ordinal?: number;
      title: string;
      link?: string;
      icon?: string;
      roles?: string[];
      items?: unknown[];
    }>;
  }>;
  saveTo?: 'database' | 'yaml' | 'both';
};

const UpdateApplicationMenus: Macro<any, UpdateApplicationMenusParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, menus, saveTo = 'both' } = params;

  if (!key || !menus) {
    return { success: false, error: 'Missing required parameters: key and menus are required.', tool: 'updateApplicationMenus', params };
  }

  try {
    if (saveTo === 'database' || saveTo === 'both') {
      // Use upsertFromConfig so menus get the full Menu model treatment
      // @ts-ignore
      const clientDoc = await ReactoryClientModel.upsertFromConfig({ key, menus }, context);
      if (!clientDoc) {
        return { success: false, error: `Application "${key}" not found.`, tool: 'updateApplicationMenus', params };
      }
    }

    const filesWritten: string[] = [];
    if (saveTo === 'yaml' || saveTo === 'both') {
      const configDir = path.join(getClientConfigsDir(), key);
      if (fs.existsSync(configDir)) {
        const menusPath = path.join(configDir, 'menus.yaml');
        writeYaml(menusPath, menus);
        filesWritten.push(menusPath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastUpdatedMenus = menus;
    chatState.vars.lastApplicationKey = key;

    return {
      success: true,
      data: {
        summary: {
          message: `Updated ${menus.length} menu(s) for application "${key}".`,
          menuKeys: menus.map(m => m.key),
          saveTo,
          filesWritten,
        },
        menus,
      },
      tool: 'updateApplicationMenus',
      params,
      format: 'json',
      instructions: `
## Menus Updated for "${key}"

Successfully updated ${menus.length} menu definition(s):
${menus.map(m => `- **${m.key}**: ${m.name || 'Unnamed'} (${(m.entries || []).length} entries)`).join('\n')}

### State Variables:
- lastUpdatedMenus: The menu definitions
- lastApplicationKey: "${key}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in updateApplicationMenus macro', { error, params });
    return { success: false, error: `Failed to update menus: ${error?.message || 'Unknown error'}`, tool: 'updateApplicationMenus', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool: exportApplication
// ─────────────────────────────────────────────────────────────────────────────

type ExportApplicationParams = {
  key: string;
  saveTo?: 'personal' | 'provision';
  includeElements?: boolean;
};

const ExportApplication: Macro<any, ExportApplicationParams> = async (
  params,
  chatState,
  context,
) => {
  const { key, saveTo = 'personal', includeElements = true } = params;

  if (!key) {
    return { success: false, error: 'Missing required parameter: key', tool: 'exportApplication', params };
  }

  try {
    const client = await ReactoryClientModel.findOne({ key }).lean();
    if (!client) {
      return { success: false, error: `Application "${key}" not found.`, tool: 'exportApplication', params };
    }

    const targetDir = saveTo === 'provision'
      ? path.join(getClientConfigsDir(), key)
      : path.join(getUserWorkingDir(context), key);

    ensureDir(targetDir);

    const filesWritten: string[] = [];
    const clientData = client as any;

    // Write main config
    const configPath = path.join(targetDir, 'config.yaml');
    writeYaml(configPath, toYamlConfig(clientData));
    filesWritten.push(configPath);

    if (includeElements) {
      // Write element files
      const elementMap: Record<string, unknown> = {
        'themes.yaml': clientData.themes,
        'routes.yaml': clientData.routes,
        'settings.yaml': clientData.settings,
        'plugins.yaml': clientData.plugins,
        'whitelist.yaml': clientData.whitelist,
      };

      for (const [filename, data] of Object.entries(elementMap)) {
        if (data && (Array.isArray(data) ? data.length > 0 : true)) {
          const filePath = path.join(targetDir, filename);
          writeYaml(filePath, data);
          filesWritten.push(filePath);
        }
      }

      if (clientData.auth_config && clientData.auth_config.length > 0) {
        const authDir = path.join(targetDir, 'authentication');
        ensureDir(authDir);
        const authPath = path.join(authDir, 'auth-config.yaml');
        writeYaml(authPath, clientData.auth_config);
        filesWritten.push(authPath);
      }
    }

    if (!chatState.vars) chatState.vars = {};
    chatState.vars.lastExportedApplication = key;
    chatState.vars.lastExportDir = targetDir;

    return {
      success: true,
      data: {
        summary: {
          message: `Exported application "${key}" to ${saveTo} folder.`,
          targetDir,
          filesWritten,
        },
      },
      tool: 'exportApplication',
      params,
      format: 'json',
      instructions: `
## Application Exported

Successfully exported "${key}" to ${saveTo === 'provision' ? 'the provisioning (clientConfigs)' : 'your personal working'} folder.

### Files Written:
${filesWritten.map(f => `- ${f}`).join('\n')}

### State Variables:
- lastExportedApplication: "${key}"
- lastExportDir: "${targetDir}"
      `,
    };
  } catch (error: any) {
    logger.error('Error in exportApplication macro', { error, params });
    return { success: false, error: `Failed to export application: ${error?.message || 'Unknown error'}`, tool: 'exportApplication', params };
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Registry / Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatcher macro — routes tool calls to the correct handler based on the
 * tool name. This is the single entry point registered with the Reactor.
 */
const ApplicationManagerDispatcher: Macro<any, { toolName: string;[key: string]: unknown }> = async (
  params,
  chatState,
  context,
) => {
  const { toolName, ...rest } = params;
  const handlers: Record<string, Macro<any, any>> = {
    createApplication: CreateApplication,
    getApplication: GetApplication,
    listApplications: ListApplications,
    updateApplicationThemes: UpdateApplicationThemes,
    updateApplicationRoutes: UpdateApplicationRoutes,
    updateApplicationSettings: UpdateApplicationSettings,
    updateApplicationAuth: UpdateApplicationAuth,
    updateApplicationPlugins: UpdateApplicationPlugins,
    updateApplicationMenus: UpdateApplicationMenus,
    exportApplication: ExportApplication,
  };

  const handler = handlers[toolName];
  if (!handler) {
    return {
      success: false,
      error: `Unknown tool "${toolName}". Available tools: ${Object.keys(handlers).join(', ')}`,
      tool: toolName,
      params,
    };
  }

  return handler(rest as any, chatState, context);
};


// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions for the LLM
// ─────────────────────────────────────────────────────────────────────────────

const SAVE_TO_PARAM = {
  type: 'string' as const,
  description: "Where to persist the data. 'database' saves to MongoDB only, 'yaml' writes to disk only, 'both' does both. Defaults to 'both'.",
  enum: ['database', 'yaml', 'both'],
};

const moduleTools: MacroToolDefinition[] = [
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'add_circle',
      name: 'createApplication',
      description: 'Create a new Reactory application definition. Generates config YAML and upserts into the database. Returns the created config for further customisation.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique identifier for the application (lowercase, hyphenated). Example: "my-marketing-app".' },
          name: { type: 'string', description: 'Human-readable display name for the application.' },
          username: { type: 'string', description: 'System username. Defaults to key if omitted.' },
          email: { type: 'string', description: 'System email for the application. Defaults to <key>@reactory.net.' },
          siteUrl: { type: 'string', description: 'Base URL where the client app is served. Defaults to http://localhost:3000.' },
          applicationRoles: {
            type: 'array',
            description: 'Roles the application exposes. At minimum include USER and ANON.',
            items: { type: 'string' },
          },
          billingType: { type: 'string', description: "Billing model. e.g. 'free', 'premium', 'enterprise'." },
          theme: { type: 'string', description: 'Default theme name for the application.' },
          allowCustomTheme: { type: 'boolean', description: 'Whether end-users can customise the theme.' },
          whitelist: {
            type: 'array',
            description: 'Allowed hostnames.',
            items: { type: 'string' },
          },
          saveTo: {
            type: 'string',
            description: "Where to write the YAML config. 'personal' saves to ~/.reactory/apps, 'provision' saves to clientConfigs, 'both' saves to both.",
            enum: ['personal', 'provision', 'both'],
          },
        },
        required: ['key', 'name'],
      },
    },
  },
  {
    type: 'function',
    roles: ['USER'],
    function: {
      icon: 'info',
      name: 'getApplication',
      description: 'Retrieve a Reactory application definition by its key. Returns the full configuration including themes, routes, menus, plugins, and settings.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key to retrieve.' },
          format: {
            type: 'string',
            description: "Output format. 'json' returns the full object, 'yaml' returns YAML text, 'summary' returns key metrics.",
            enum: ['json', 'yaml', 'summary'],
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    roles: ['USER'],
    function: {
      icon: 'list',
      name: 'listApplications',
      description: 'List all registered Reactory application definitions. Returns a summary of each application.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: "Output format. 'summary' returns key/name pairs, 'markdown' returns a table, 'json' returns full objects.",
            enum: ['json', 'markdown', 'summary'],
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'palette',
      name: 'updateApplicationThemes',
      description: 'Set or replace the themes for a Reactory application. Provide complete theme definitions including palettes, modes, assets, and content.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key.' },
          themes: {
            type: 'array',
            description: 'Array of complete IReactoryTheme objects. Each theme must have a name, type, and at least one mode with palette.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Theme name identifier.' },
                type: { type: 'string', description: "Theme type, e.g. 'material'." },
                description: { type: 'string', description: 'Human-readable theme description.' },
                defaultThemeMode: { type: 'string', description: "Default mode ('light' or 'dark').", enum: ['light', 'dark'] },
                modes: {
                  type: 'array',
                  description: 'Theme mode definitions.',
                  items: {
                    type: 'object',
                    properties: {
                      mode: { type: 'string', enum: ['light', 'dark'] },
                      name: { type: 'string' },
                      description: { type: 'string' },
                      icon: { type: 'string' },
                      options: {
                        type: 'object',
                        description: 'MUI palette options including primary, secondary, background colours.',
                      },
                    },
                  },
                },
                assets: {
                  type: 'array',
                  description: 'Theme assets (logo, favicon, feature image, etc.).',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      url: { type: 'string' },
                      assetType: { type: 'string' },
                    },
                  },
                },
                content: {
                  type: 'object',
                  description: 'Theme content strings like appTitle and login message.',
                },
              },
            },
          },
          saveTo: SAVE_TO_PARAM,
        },
        required: ['key', 'themes'],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'route',
      name: 'updateApplicationRoutes',
      description: 'Define or replace the URL routes for a Reactory application. Each route maps a URL path to a React component.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key.' },
          routes: {
            type: 'array',
            description: 'Array of route definitions.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Unique route key.' },
                title: { type: 'string', description: 'Route title for navigation.' },
                path: { type: 'string', description: 'URL path pattern, e.g. "/dashboard".' },
                public: { type: 'boolean', description: 'Whether the route is publicly accessible.' },
                roles: { type: 'array', items: { type: 'string' }, description: 'Required roles.' },
                exact: { type: 'boolean', description: 'Whether to match the path exactly.' },
                componentFqn: { type: 'string', description: 'Fully qualified component name to render.' },
                redirect: { type: 'string', description: 'Redirect target path if applicable.' },
              },
            },
          },
          saveTo: SAVE_TO_PARAM,
        },
        required: ['key', 'routes'],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'settings',
      name: 'updateApplicationSettings',
      description: 'Configure application-level settings for a Reactory application. Settings control runtime behaviour and feature toggles.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key.' },
          settings: {
            type: 'array',
            description: 'Array of application settings.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Setting name identifier.' },
                settingType: { type: 'string', description: 'Type classification of the setting.' },
                variant: { type: 'string', description: 'Variant selector.' },
                title: { type: 'string', description: 'Human-readable title for the setting.' },
                description: { type: 'string', description: 'Description of what the setting controls.' },
                componentFqn: { type: 'string', description: 'Optional component FQN for rendering a settings editor.' },
                data: { type: 'object', description: 'The setting value / data payload.' },
              },
            },
          },
          saveTo: SAVE_TO_PARAM,
        },
        required: ['key', 'settings'],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'security',
      name: 'updateApplicationAuth',
      description: 'Configure authentication providers for a Reactory application. Supports local auth, OAuth providers, SAML, etc.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key.' },
          auth_config: {
            type: 'array',
            description: 'Authentication provider configurations.',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string', description: "Provider name, e.g. 'local', 'google', 'microsoft', 'github'." },
                enabled: { type: 'boolean', description: 'Whether this provider is enabled.' },
                properties: { type: 'object', description: 'Provider-specific configuration properties (client ID, secret, etc.).' },
              },
            },
          },
          saveTo: SAVE_TO_PARAM,
        },
        required: ['key', 'auth_config'],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'extension',
      name: 'updateApplicationPlugins',
      description: 'Register or update client-side plugins for a Reactory application. Plugins are dynamically loaded components/resources.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key.' },
          plugins: {
            type: 'array',
            description: 'Plugin definitions.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Plugin name.' },
                nameSpace: { type: 'string', description: 'Plugin namespace.' },
                version: { type: 'string', description: 'Plugin version.' },
                description: { type: 'string', description: 'Plugin description.' },
                platform: { type: 'string', description: "Target platform ('web', 'native', 'both')." },
                uri: { type: 'string', description: 'URI to the plugin resource.' },
                loader: { type: 'string', description: "Loader type ('script', 'module', etc.)." },
                enabled: { type: 'boolean', description: 'Whether the plugin is enabled.' },
                roles: { type: 'array', items: { type: 'string' }, description: 'Roles that can use this plugin.' },
              },
            },
          },
          saveTo: SAVE_TO_PARAM,
        },
        required: ['key', 'plugins'],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'menu',
      name: 'updateApplicationMenus',
      description: 'Define or replace navigation menus for a Reactory application. Each menu has a key, entries, and role-based visibility.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key.' },
          menus: {
            type: 'array',
            description: 'Menu definitions.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Unique menu key.' },
                name: { type: 'string', description: 'Menu display name.' },
                target: { type: 'string', description: "Target area, e.g. 'left-nav', 'top-nav'." },
                roles: { type: 'array', items: { type: 'string' }, description: 'Roles that see this menu.' },
                entries: {
                  type: 'array',
                  description: 'Menu entries (items).',
                  items: {
                    type: 'object',
                    properties: {
                      ordinal: { type: 'number', description: 'Sort order.' },
                      title: { type: 'string', description: 'Display title.' },
                      link: { type: 'string', description: 'Navigation link.' },
                      icon: { type: 'string', description: 'Material icon name.' },
                      roles: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          saveTo: SAVE_TO_PARAM,
        },
        required: ['key', 'menus'],
      },
    },
  },
  {
    type: 'function',
    roles: ['ADMIN'],
    function: {
      icon: 'file_download',
      name: 'exportApplication',
      description: "Export a Reactory application from the database to YAML config files. Writes config.yaml and element files (themes, routes, settings, plugins, etc.) to disk.",
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The application key to export.' },
          saveTo: {
            type: 'string',
            description: "Target directory: 'personal' writes to ~/.reactory/apps/<key>, 'provision' writes to clientConfigs/<key>.",
            enum: ['personal', 'provision'],
          },
          includeElements: {
            type: 'boolean',
            description: 'Whether to write separate element files (themes.yaml, routes.yaml, etc.) in addition to config.yaml. Defaults to true.',
          },
        },
        required: ['key'],
      },
    },
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// Macro Component Definition (Registry Entry)
// ─────────────────────────────────────────────────────────────────────────────

const ApplicationManagerTools: MacroComponentDefinition<unknown>[] = [
  {
    nameSpace: 'reactory-reactor',
    name: 'createApplication',
    version: '1.0.0',
    component: CreateApplication,
    description: `# createApplication\nCreate a new Reactory application definition with YAML config generation and database persistence.\n\n## Usage\ncreateApplication(key, name, saveTo?) – scaffolds a new application.`,
    features: [
      { feature: 'create', featureType: Reactory.FeatureType.function, action: ['create', 'new', 'scaffold'], description: 'Creates a new Reactory application definition.', stem: 'create' },
    ],
    stem: 'application',
    alias: 'createApplication',
    roles: ['ADMIN'],
    icon: 'add_circle',
    tags: ['application', 'create', 'scaffold', 'module', 'config', 'yaml'],
    runat: 'server',
    tools: [moduleTools[0]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'getApplication',
    version: '1.0.0',
    component: GetApplication,
    description: `# getApplication\nRetrieve a Reactory application by its key.\n\n## Usage\ngetApplication(key, format?) – returns the application config.`,
    features: [
      { feature: 'read', featureType: Reactory.FeatureType.function, action: ['read', 'get', 'fetch'], description: 'Retrieves a Reactory application definition.', stem: 'read' },
    ],
    stem: 'application',
    alias: 'getApplication',
    roles: ['USER'],
    icon: 'info',
    tags: ['application', 'get', 'read', 'config'],
    runat: 'server',
    tools: [moduleTools[1]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'listApplications',
    version: '1.0.0',
    component: ListApplications,
    description: `# listApplications\nList all registered Reactory applications.\n\n## Usage\nlistApplications(format?) – returns all application summaries.`,
    features: [
      { feature: 'list', featureType: Reactory.FeatureType.function, action: ['list', 'fetch', 'get'], description: 'Lists all Reactory applications.', stem: 'list' },
    ],
    stem: 'application',
    alias: 'listApplications',
    roles: ['USER'],
    icon: 'list',
    tags: ['application', 'list', 'all'],
    runat: 'server',
    tools: [moduleTools[2]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'updateApplicationThemes',
    version: '1.0.0',
    component: UpdateApplicationThemes,
    description: `# updateApplicationThemes\nUpdate the theme definitions for a Reactory application.\n\n## Usage\nupdateApplicationThemes(key, themes, saveTo?) – replaces the application themes.`,
    features: [
      { feature: 'update', featureType: Reactory.FeatureType.function, action: ['update', 'set', 'configure'], description: 'Updates application themes.', stem: 'update' },
    ],
    stem: 'application',
    alias: 'updateApplicationThemes',
    roles: ['ADMIN'],
    icon: 'palette',
    tags: ['application', 'themes', 'update', 'palette', 'ui'],
    runat: 'server',
    tools: [moduleTools[3]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'updateApplicationRoutes',
    version: '1.0.0',
    component: UpdateApplicationRoutes,
    description: `# updateApplicationRoutes\nDefine or replace URL routes for a Reactory application.\n\n## Usage\nupdateApplicationRoutes(key, routes, saveTo?) – synchronises routes.`,
    features: [
      { feature: 'update', featureType: Reactory.FeatureType.function, action: ['update', 'set', 'configure'], description: 'Updates application routes.', stem: 'update' },
    ],
    stem: 'application',
    alias: 'updateApplicationRoutes',
    roles: ['ADMIN'],
    icon: 'route',
    tags: ['application', 'routes', 'update', 'navigation'],
    runat: 'server',
    tools: [moduleTools[4]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'updateApplicationSettings',
    version: '1.0.0',
    component: UpdateApplicationSettings,
    description: `# updateApplicationSettings\nConfigure application settings for a Reactory application.\n\n## Usage\nupdateApplicationSettings(key, settings, saveTo?) – updates settings.`,
    features: [
      { feature: 'update', featureType: Reactory.FeatureType.function, action: ['update', 'set', 'configure'], description: 'Updates application settings.', stem: 'update' },
    ],
    stem: 'application',
    alias: 'updateApplicationSettings',
    roles: ['ADMIN'],
    icon: 'settings',
    tags: ['application', 'settings', 'update', 'config'],
    runat: 'server',
    tools: [moduleTools[5]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'updateApplicationAuth',
    version: '1.0.0',
    component: UpdateApplicationAuth,
    description: `# updateApplicationAuth\nConfigure authentication providers for a Reactory application.\n\n## Usage\nupdateApplicationAuth(key, auth_config, saveTo?) – updates auth config.`,
    features: [
      { feature: 'update', featureType: Reactory.FeatureType.function, action: ['update', 'set', 'configure'], description: 'Updates auth providers.', stem: 'update' },
    ],
    stem: 'application',
    alias: 'updateApplicationAuth',
    roles: ['ADMIN'],
    icon: 'security',
    tags: ['application', 'auth', 'authentication', 'update', 'security'],
    runat: 'server',
    tools: [moduleTools[6]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'updateApplicationPlugins',
    version: '1.0.0',
    component: UpdateApplicationPlugins,
    description: `# updateApplicationPlugins\nRegister or update plugins for a Reactory application.\n\n## Usage\nupdateApplicationPlugins(key, plugins, saveTo?) – updates plugin registry.`,
    features: [
      { feature: 'update', featureType: Reactory.FeatureType.function, action: ['update', 'set', 'configure'], description: 'Updates application plugins.', stem: 'update' },
    ],
    stem: 'application',
    alias: 'updateApplicationPlugins',
    roles: ['ADMIN'],
    icon: 'extension',
    tags: ['application', 'plugins', 'update', 'extension'],
    runat: 'server',
    tools: [moduleTools[7]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'updateApplicationMenus',
    version: '1.0.0',
    component: UpdateApplicationMenus,
    description: `# updateApplicationMenus\nDefine navigation menus for a Reactory application.\n\n## Usage\nupdateApplicationMenus(key, menus, saveTo?) – updates menu definitions.`,
    features: [
      { feature: 'update', featureType: Reactory.FeatureType.function, action: ['update', 'set', 'configure'], description: 'Updates application menus.', stem: 'update' },
    ],
    stem: 'application',
    alias: 'updateApplicationMenus',
    roles: ['ADMIN'],
    icon: 'menu',
    tags: ['application', 'menus', 'update', 'navigation'],
    runat: 'server',
    tools: [moduleTools[8]],
  },
  {
    nameSpace: 'reactory-reactor',
    name: 'exportApplication',
    version: '1.0.0',
    component: ExportApplication,
    description: `# exportApplication\nExport a Reactory application from the database to YAML config files.\n\n## Usage\nexportApplication(key, saveTo?, includeElements?) – writes config to disk.`,
    features: [
      { feature: 'export', featureType: Reactory.FeatureType.function, action: ['export', 'save', 'write'], description: 'Exports application to YAML files.', stem: 'export' },
    ],
    stem: 'application',
    alias: 'exportApplication',
    roles: ['ADMIN'],
    icon: 'file_download',
    tags: ['application', 'export', 'yaml', 'config', 'save'],
    runat: 'server',
    tools: [moduleTools[9]],
  },
];

export default ApplicationManagerTools;

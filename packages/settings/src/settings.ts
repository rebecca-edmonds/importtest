import { PageConfig, URLExt } from '@jupyterlab/coreutils';

import * as json5 from 'json5';

import { IFederatedExtension } from '@jupyterlite/types';

import { IPlugin, ISettings } from './tokens';
import { PromiseDelegate } from '@lumino/coreutils';
import { IForager, Forager } from '@jupyterlite/localforage';

/**
 * A class to handle requests to /api/settings
 */
export class Settings implements ISettings {
  constructor(options: Settings.IOptions) {
    this._forager = this.createDefaultStorage(options);
    this._ready = new PromiseDelegate();
  }

  /**
   * Initialize the default storage for settings.
   */
  protected createDefaultStorage(options: IForager.IOptions): IForager {
    const { localforage, storageName, storageDrivers } = options;
    return new Forager({
      localforage,
      storageDrivers,
      storageName,
      description: 'Offline Storage for Settings',
      storeName: 'settings',
    });
  }

  /**
   * A promise that resolves when the settings storage is fully initialized
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * A lazy reference to initialized storage
   */
  protected get storage(): Promise<LocalForage> {
    return this.ready.then(() => this._forager.storage);
  }

  /**
   * Finish any initialization after server has started and all extensions are applied.
   */
  async initialize() {
    await this._forager.initialize();
    await this._forager.ready;
    this._ready.resolve(void 0);
  }

  /**
   * Get settings by plugin id
   *
   * @param pluginId the id of the plugin
   *
   */
  async get(pluginId: string): Promise<IPlugin | undefined> {
    const all = await this.getAll();
    const settings = all.settings as IPlugin[];
    let found = settings.find((setting: IPlugin) => {
      return setting.id === pluginId;
    });

    if (!found) {
      found = await this._getFederated(pluginId);
    }

    return found;
  }

  /**
   * Get all the settings
   */
  async getAll(): Promise<{ settings: IPlugin[] }> {
    const settingsUrl = PageConfig.getOption('settingsUrl') ?? '/';
    const storage = await this.storage;
    const all = (await (
      await fetch(URLExt.join(settingsUrl, 'all.json'))
    ).json()) as IPlugin[];
    const settings = await Promise.all(
      all.map(async (plugin) => {
        const { id } = plugin;
        const raw = ((await storage.getItem(id)) as string) ?? plugin.raw;
        return {
          ...Private.override(plugin),
          raw,
          settings: json5.parse(raw),
        };
      })
    );
    return { settings };
  }

  /**
   * Save settings for a given plugin id
   *
   * @param pluginId The id of the plugin
   * @param raw The raw settings
   *
   */
  async save(pluginId: string, raw: string): Promise<void> {
    await (await this.storage).setItem(pluginId, raw);
  }

  /**
   * Get the settings for a federated extension
   *
   * @param pluginId The id of a plugin
   */
  private async _getFederated(pluginId: string): Promise<IPlugin | undefined> {
    const [packageName, schemaName] = pluginId.split(':');

    if (!Private.isFederated(packageName)) {
      return;
    }

    const labExtensionsUrl = PageConfig.getOption('fullLabextensionsUrl');
    const schemaUrl = URLExt.join(
      labExtensionsUrl,
      packageName,
      'schemas',
      packageName,
      `${schemaName}.json`
    );
    const packageUrl = URLExt.join(labExtensionsUrl, packageName, 'package.json');
    const schema = await (await fetch(schemaUrl)).json();
    const packageJson = await (await fetch(packageUrl)).json();
    const raw = ((await (await this.storage).getItem(pluginId)) as string) ?? '{}';
    const settings = json5.parse(raw) || {};
    return Private.override({
      id: pluginId,
      raw,
      schema,
      settings,
      version: packageJson.version || '3.0.8',
    });
  }

  private _ready: PromiseDelegate<void>;

  private _forager: IForager;
}

/**
 * A namespace for settings metadata.
 */
export namespace Settings {
  /**
   * Initialization options for settings.
   */
  export interface IOptions extends IForager.IOptions {}
}

/**
 * A namespace for private data
 */
namespace Private {
  const _overrides: Record<string, IPlugin['schema']['default']> = JSON.parse(
    PageConfig.getOption('settingsOverrides') || '{}'
  );

  /**
   * Test whether this package is configured in `federated_extensions` in this app
   *
   * @param packageName The npm name of a package
   */
  export function isFederated(packageName: string): boolean {
    let federated: IFederatedExtension[];

    try {
      federated = JSON.parse(PageConfig.getOption('federated_extensions'));
    } catch {
      return false;
    }

    for (const { name } of federated) {
      if (name === packageName) {
        return true;
      }
    }

    return false;
  }

  /**
   * Override the defaults of the schema with ones from PageConfig
   *
   * @see https://github.com/jupyterlab/jupyterlab_server/blob/v2.5.2/jupyterlab_server/settings_handler.py#L216-L227
   */
  export function override(plugin: IPlugin): IPlugin {
    if (_overrides[plugin.id]) {
      if (!plugin.schema.properties) {
        // probably malformed, or only provides keyboard shortcuts, etc.
        plugin.schema.properties = {};
      }
      for (const [prop, propDefault] of Object.entries(_overrides[plugin.id] || {})) {
        plugin.schema.properties[prop].default = propDefault;
      }
    }
    return plugin;
  }
}

// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PromiseDelegate } from '@lumino/coreutils';
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { Workspace } from '@jupyterlab/services/lib/workspace';
import { IForager, Forager } from '@jupyterlite/localforage';
import { IWorkspaces } from './tokens';

/** A service for storing and retrieving Workspaces in localforage or the server */
export class Workspaces implements IWorkspaces {
  constructor(options: Workspaces.IOptions) {
    this._forager = this.createDefaultStorage(options);
    this._ready = new PromiseDelegate();
  }

  /**
   * Initialize the default storage for workspaces.
   */
  protected createDefaultStorage(options: IForager.IOptions): IForager {
    const { localforage, storageName, storageDrivers } = options;
    return new Forager({
      localforage,
      storageDrivers,
      storageName,
      storeName: 'workspaces',
      description: 'Offline Storage for Workspaces',
    });
  }

  /**
   * A promise that resolves when the workspace storage is fully initialized
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

  /** Get the workspaces API URL from the page config.  */
  get workspacesApiUrl(): string {
    return (
      PageConfig.getOption('workspacesApiUrl') ||
      URLExt.join(PageConfig.getBaseUrl(), 'api/workspaces')
    );
  }

  /** Get all the workspaces */
  async getAll(): Promise<IWorkspaces.IWorkspacesBundle> {
    const storage = await this.storage;
    const keys = await storage.keys();
    const bundle: IWorkspaces.IWorkspacesBundle = await this.getAllServer();
    await Promise.all(
      keys.map(async (workspaceId) => {
        const workspace = await storage.getItem<Workspace.IWorkspace>(workspaceId);
        if (workspace) {
          bundle[workspaceId] = workspace;
        }
      })
    );
    return bundle;
  }

  async getAllServer(): Promise<IWorkspaces.IWorkspacesBundle> {
    try {
      return await (await fetch(URLExt.join(this.workspacesApiUrl, 'all.json'))).json();
    } catch {
      console.info('No workspaces found on web server: no need to worry!');
      return {};
    }
  }

  /** Get a workspace by id */
  async getWorkspace(workspaceId: string): Promise<Workspace.IWorkspace> {
    let workspace = await (
      await this.storage
    ).getItem<Workspace.IWorkspace>(workspaceId);

    if (!workspace) {
      workspace = (await this.getAllServer())[workspaceId];
    }

    if (!workspace) {
      throw new Error(`${workspaceId} not found`);
    }

    return workspace;
  }

  /** Update a workspace by id */
  async setWorkspace(
    workspaceId: string,
    workspace: Workspace.IWorkspace
  ): Promise<Workspace.IWorkspace> {
    const { data, metadata } = workspace;
    // normalize to what jupyterlab_server emits
    const now = new Date().toISOString().replace('Z', '+00:00');
    await (
      await this.storage
    ).setItem<Workspace.IWorkspace>(workspaceId, {
      data,
      metadata: {
        ...{ created: now },
        ...metadata,
        ...{ last_updated: now },
        id: workspaceId,
      },
    });
    return this.getWorkspace(workspaceId);
  }

  /** Delete a workspace by id */
  async deleteWorkspace(workspaceId: string): Promise<Workspace.IWorkspace> {
    const workspace = await this.getWorkspace(workspaceId);
    const storage = await this.storage;
    await storage.removeItem(workspaceId);
    return workspace;
  }

  private _forager: IForager;
  private _ready: PromiseDelegate<void>;
}

/** A namespace for Workspaces types */
export namespace Workspaces {
  /** Initialization options for Workspaces */
  export interface IOptions extends IForager.IOptions {}
}

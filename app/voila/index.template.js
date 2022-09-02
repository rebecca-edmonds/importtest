// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Panel, Widget } from '@lumino/widgets';

import { JupyterLiteServer } from '@jupyterlite/server';

// The webpack public path needs to be set before loading the CSS assets.
import { PageConfig } from '@jupyterlab/coreutils';

import { OutputArea, OutputAreaModel } from '@jupyterlab/outputarea';
import {
  IRenderMimeRegistry,
  RenderMimeRegistry,
  standardRendererFactories
} from '@jupyterlab/rendermime';

import {
  KernelWidgetManager,
  WidgetRenderer,
  output,
} from '@jupyter-widgets/jupyterlab-manager';
import * as base from '@jupyter-widgets/base';
import * as controls from '@jupyter-widgets/controls';

import { VoilaApp, OutputModel, plugins } from '@voila-dashboards/voila';

require('./style.js');

const WIDGET_MIMETYPE = 'application/vnd.jupyter.widget-view+json';

const serverExtensions = [
  import('@jupyterlite/javascript-kernel-extension'),
  import('@jupyterlite/pyolite-kernel-extension'),
  import('@jupyterlite/server-extension')
];

const mimeExtensionsMods = [
  import('@jupyterlite/iframe-extension'),
  import('@jupyterlab/javascript-extension'),
  import('@jupyterlab/json-extension'),
  import('@jupyterlab/vega5-extension')
];

const disabled = ['@jupyter-widgets/jupyterlab-manager'];


let resolveManager;
const managerPromise = new Promise((resolve) => {
  resolveManager = resolve;
})


class VoilaWidgetManager extends KernelWidgetManager {
  constructor(kernel, rendermime) {
    super(kernel, rendermime);
    rendermime.addFactory(
      {
        safe: false,
        mimeTypes: [WIDGET_MIMETYPE],
        createRenderer: options => new WidgetRenderer(options, this)
      },
      -10
    );
    this._registerWidgets();
  }

  _registerWidgets() {
    this.register({
      name: '@jupyter-widgets/base',
      version: base.JUPYTER_WIDGETS_VERSION,
      exports: base
    });
    this.register({
      name: '@jupyter-widgets/controls',
      version: controls.JUPYTER_CONTROLS_VERSION,
      exports: controls
    });
    this.register({
      name: '@jupyter-widgets/output',
      version: output.OUTPUT_WIDGET_VERSION,
      exports: {
        ...output,
        OutputModel
      }
    });
  }
}


/**
 * The Voila widgets manager plugin.
 */
 const widgetManager = {
  id: '@voila-dashboards/voila:widget-manager',
  autoStart: true,
  requires: [IRenderMimeRegistry],
  provides: base.IJupyterWidgetRegistry,
  activate: async (
    app,
    rendermime
  ) => {
    return {
      registerWidget: async (data) => {
        const manager = await managerPromise;

        manager.register(data);
      }
    };
  }
};


async function createModule(scope, module) {
  try {
    const factory = await window._JUPYTERLAB[scope].get(module);
    return factory();
  } catch (e) {
    console.warn(`Failed to create module: package: ${scope}; module: ${module}`);
    throw e;
  }
}

/**
 * The main entry point for the application.
 */
export async function main() {
  const mimeExtensions = await Promise.all(mimeExtensionsMods);

  let baseMods = [
    require('@jupyterlab/apputils-extension').default.filter(({ id }) =>
      [
        '@jupyterlab/apputils-extension:settings',
        '@jupyterlab/apputils-extension:themes',
      ].includes(id)
    ),
    require('@jupyterlab/mathjax2-extension'),
    require('@jupyterlab/markdownviewer-extension'),
    require('@jupyterlab/rendermime-extension'),
    require('@jupyterlab/theme-light-extension'),
    // Voila plugins
    plugins.default.filter(({ id }) =>
      [
        // Not including Voila's widget manager
        // '@voila-dashboards/voila:widget-manager',
        '@voila-dashboards/voila:translator',
        '@voila-dashboards/voila:paths',
      ].includes(id)
    ),
    widgetManager,
  ];

  // The motivation here is to only load a specific set of plugins dependending on
  // the current page
  const page = PageConfig.getOption('voilaPage');
  switch (page) {
    case 'render': {
      // TODO WHAT
      // baseMods = baseMods.concat([
      //   require('@jupyterlab/filebrowser-extension').default.filter(({ id }) =>
      //     [
      //       '@jupyterlab/filebrowser-extension:browser',
      //       '@jupyterlab/filebrowser-extension:file-upload-status',
      //       '@jupyterlab/filebrowser-extension:open-with',
      //     ].includes(id)
      //   ),
      //   // do not enable the new terminal button from RetroLab
      //   require('@retrolab/tree-extension').default.filter(
      //     ({ id }) => id !== '@retrolab/tree-extension:new-terminal'
      //   )
      // ]);
      break;
    }
    case 'tree': {
      // TODO WHAT
      // baseMods = baseMods.concat([
      //   require('@jupyterlab/cell-toolbar-extension'),
      //   require('@jupyterlab/completer-extension').default.filter(({ id }) =>
      //     ['@jupyterlab/completer-extension:notebooks'].includes(id)
      //   ),
      //   require('@jupyterlab/tooltip-extension').default.filter(({ id }) =>
      //     [
      //       '@jupyterlab/tooltip-extension:manager',
      //       '@jupyterlab/tooltip-extension:notebooks'
      //     ].includes(id)
      //   )
      // ]);
      break;
    }
  }

  const mods = [];
  const federatedExtensionPromises = [];
  const federatedMimeExtensionPromises = [];
  const federatedStylePromises = [];
  const litePluginsToRegister = [];
  const liteExtensionPromises = [];

  // This is all the data needed to load and activate plugins. This should be
  // gathered by the server and put onto the initial page template.
  const extensions = JSON.parse(
    PageConfig.getOption('federated_extensions')
  );

  // The set of federated extension names.
  const federatedExtensionNames = new Set();

  extensions.forEach(data => {
    if (data.liteExtension) {
      liteExtensionPromises.push(createModule(data.name, data.extension));
      return;
    }
    if (data.extension) {
      federatedExtensionNames.add(data.name);
      federatedExtensionPromises.push(createModule(data.name, data.extension));
    }
    if (data.mimeExtension) {
      federatedExtensionNames.add(data.name);
      federatedMimeExtensionPromises.push(createModule(data.name, data.mimeExtension));
    }
    if (data.style) {
      federatedStylePromises.push(createModule(data.name, data.style));
    }
  });

  /**
   * Iterate over active plugins in an extension.
   */
  function* activePlugins(extension) {
    // Handle commonjs or es2015 modules
    let exports;
    if (extension.hasOwnProperty('__esModule')) {
      exports = extension.default;
    } else {
      // CommonJS exports.
      exports = extension;
    }

    let plugins = Array.isArray(exports) ? exports : [exports];
    for (let plugin of plugins) {
      if (
        PageConfig.Extension.isDisabled(plugin.id) ||
        disabled.includes(plugin.id) ||
        disabled.includes(plugin.id.split(':')[0])
      ) {
        continue;
      }
      yield plugin;
    }
  }

  // Add the base frontend extensions
  const baseFrontendMods = await Promise.all(baseMods);
  baseFrontendMods.forEach(p => {
    for (let plugin of activePlugins(p)) {
      mods.push(plugin);
    }
  });

  // Add the federated mime extensions.
  const federatedMimeExtensions = await Promise.allSettled(federatedMimeExtensionPromises);
  federatedMimeExtensions.forEach(p => {
    if (p.status === "fulfilled") {
      for (let plugin of activePlugins(p.value)) {
        mimeExtensions.push(plugin);
      }
    } else {
      console.error(p.reason);
    }
  });

  // Add the federated extensions.
  const federatedExtensions = await Promise.allSettled(federatedExtensionPromises);
  federatedExtensions.forEach(p => {
    if (p.status === "fulfilled") {
      for (let plugin of activePlugins(p.value)) {
        mods.push(plugin);
      }
    } else {
      console.error(p.reason);
    }
  });

  // Add the base serverlite extensions
  const baseServerExtensions = await Promise.all(serverExtensions);
  baseServerExtensions.forEach(p => {
    for (let plugin of activePlugins(p)) {
      litePluginsToRegister.push(plugin);
    }
  });

  // Add the serverlite federated extensions.
  const federatedLiteExtensions = await Promise.allSettled(liteExtensionPromises);
  federatedLiteExtensions.forEach(p => {
    if (p.status === "fulfilled") {
      for (let plugin of activePlugins(p.value)) {
        litePluginsToRegister.push(plugin);
      }
    } else {
      console.error(p.reason);
    }
  });

  // create the in-browser JupyterLite Server
  const jupyterLiteServer = new JupyterLiteServer({});
  jupyterLiteServer.registerPluginModules(litePluginsToRegister);
  // start the server
  await jupyterLiteServer.start();

  // retrieve the custom service manager from the server app
  const { serviceManager } = jupyterLiteServer;

  // create a RetroLab frontend
  const app = new VoilaApp({ serviceManager, mimeExtensions });

  app.name = PageConfig.getOption('appName') || 'Voilite';

  app.registerPluginModules(mods);

  await app.start();
  await app.restored;

  await serviceManager.ready;

  const search = window.location.search;
  const urlParams = new URLSearchParams(search);
  const notebookName = urlParams.get('notebook')?.trim();

  let notebook;
  try {
    notebook = await app.serviceManager.contents.get(
      decodeURIComponent(notebookName),
      { content: true }
    );
  } catch(e) {
    // TODO Do this earlier and maybe differently
    const errordiv = document.createElement('div');
    errordiv.innerHTML = `404 ${notebookName} not found ${e}`;
    document.body.appendChild(errordiv);
    return;
  }

  const sessionManager = serviceManager.sessions;
  await sessionManager.ready;

  // TODO Spawn the right kernel depending on what's in the Notebook metadata
  // Find the right jupyterlite plugin for doing this
  const connection = await sessionManager.startNew({
    name: notebook.name,
    path: notebook.name,
    type: 'notebook',
    kernel: {
      name: 'xeus-python',
    },
  });

  const mainLayout = new Panel();

  document.body.style.background = 'var(--jp-layout-color1)';
  document.body.style.height = '100%';

  connection.kernel.connectionStatusChanged.connect(async (_, status) => {
    if (status === 'connected') {
      await connection.kernel.requestKernelInfo();

      const rendermime = new RenderMimeRegistry({
        initialFactories: standardRendererFactories
      });

      // Create Voila widget manager
      const widgetManager = new VoilaWidgetManager(connection.kernel, rendermime);
      resolveManager(widgetManager);

      // Execute Notebook
      for (const cell of notebook.content.cells) {
        switch (cell.cell_type) {
          case 'code': {
            const model = new OutputAreaModel({ trusted: true });
            const area = new OutputArea({
              model,
              rendermime,
            });

            area.future = connection.kernel.requestExecute({
              code: cell.source
            });
            const result = await area.future.done;

            mainLayout.addWidget(area);
            break;
          }
        }
      }

      Widget.attach(mainLayout, app.shell.node);
    }
  })

  window.voiliteKernel = connection.kernel;
  window.jupyterapp = app;
}

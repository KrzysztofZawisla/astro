import type { Plugin as VitePlugin } from 'vite';
import type { AstroAdapter, AstroConfig } from '../../../@types/astro';
import type { SerializedRouteInfo, SerializedSSRManifest } from '../../app/types';
import type { StaticBuildOptions } from '../types';

import glob from 'fast-glob';
import { fileURLToPath } from 'url';
import { runHookBuildSsr } from '../../../integrations/index.js';
import { isHybridOutput } from '../../../prerender/utils.js';
import { BEFORE_HYDRATION_SCRIPT_ID, PAGE_SCRIPT_ID } from '../../../vite-plugin-scripts/index.js';
import { pagesVirtualModuleId } from '../../app/index.js';
import { joinPaths, prependForwardSlash } from '../../path.js';
import { serializeRouteData } from '../../routing/index.js';
import { addRollupInput } from '../add-rollup-input.js';
import { getOutFile, getOutFolder } from '../common.js';
import { cssOrder, mergeInlineCss, type BuildInternals } from '../internal.js';
import type { AstroBuildPlugin } from '../plugin';

export const virtualModuleId = '@astrojs-ssr-virtual-entry';
const resolvedVirtualModuleId = '\0' + virtualModuleId;
const manifestReplace = '@@ASTRO_MANIFEST_REPLACE@@';
const replaceExp = new RegExp(`['"](${manifestReplace})['"]`, 'g');

function vitePluginSSR(
	internals: BuildInternals,
	adapter: AstroAdapter,
	config: AstroConfig
): VitePlugin {
	return {
		name: '@astrojs/vite-plugin-astro-ssr',
		enforce: 'post',
		options(opts) {
			return addRollupInput(opts, [virtualModuleId]);
		},
		resolveId(id) {
			if (id === virtualModuleId) {
				return resolvedVirtualModuleId;
			}
		},
		load(id) {
			if (id === resolvedVirtualModuleId) {
				let middleware = '';
				if (config.experimental?.middleware === true) {
					middleware = 'middleware: _main.middleware';
				}
				return `import * as adapter from '${adapter.serverEntrypoint}';
import * as _main from '${pagesVirtualModuleId}';
import { deserializeManifest as _deserializeManifest } from 'astro/app';
import { _privateSetManifestDontUseThis } from 'astro:ssr-manifest';
const _manifest = Object.assign(_deserializeManifest('${manifestReplace}'), {
	pageMap: _main.pageMap,
	renderers: _main.renderers,
	${middleware}
});
_privateSetManifestDontUseThis(_manifest);
const _args = ${adapter.args ? JSON.stringify(adapter.args) : 'undefined'};
export * from '${pagesVirtualModuleId}';
${
	adapter.exports
		? `const _exports = adapter.createExports(_manifest, _args);
${adapter.exports
	.map((name) => {
		if (name === 'default') {
			return `const _default = _exports['default'];
export { _default as default };`;
		} else {
			return `export const ${name} = _exports['${name}'];`;
		}
	})
	.join('\n')}
`
		: ''
}
const _start = 'start';
if(_start in adapter) {
	adapter[_start](_manifest, _args);
}`;
			}
			return void 0;
		},
		async generateBundle(_opts, bundle) {
			// Add assets from this SSR chunk as well.
			for (const [_chunkName, chunk] of Object.entries(bundle)) {
				if (chunk.type === 'asset') {
					internals.staticFiles.add(chunk.fileName);
				}
			}

			for (const [chunkName, chunk] of Object.entries(bundle)) {
				if (chunk.type === 'asset') {
					continue;
				}
				if (chunk.modules[resolvedVirtualModuleId]) {
					internals.ssrEntryChunk = chunk;
					delete bundle[chunkName];
				}
			}
		},
	};
}

export async function injectManifest(buildOpts: StaticBuildOptions, internals: BuildInternals) {
	if (!internals.ssrEntryChunk) {
		throw new Error(`Did not generate an entry chunk for SSR`);
	}

	// Add assets from the client build.
	const clientStatics = new Set(
		await glob('**/*', {
			cwd: fileURLToPath(buildOpts.buildConfig.client),
		})
	);
	for (const file of clientStatics) {
		internals.staticFiles.add(file);
	}

	const staticFiles = internals.staticFiles;
	const manifest = buildManifest(buildOpts, internals, Array.from(staticFiles));
	await runHookBuildSsr({
		config: buildOpts.settings.config,
		manifest,
		logging: buildOpts.logging,
	});

	const chunk = internals.ssrEntryChunk;
	const code = chunk.code;

	return code.replace(replaceExp, () => {
		return JSON.stringify(manifest);
	});
}

function buildManifest(
	opts: StaticBuildOptions,
	internals: BuildInternals,
	staticFiles: string[]
): SerializedSSRManifest {
	const { settings } = opts;

	const routes: SerializedRouteInfo[] = [];
	const entryModules = Object.fromEntries(internals.entrySpecifierToBundleMap.entries());
	if (settings.scripts.some((script) => script.stage === 'page')) {
		staticFiles.push(entryModules[PAGE_SCRIPT_ID]);
	}

	const prefixAssetPath = (pth: string) => {
		if (settings.config.build.assetsPrefix) {
			return joinPaths(settings.config.build.assetsPrefix, pth);
		} else {
			return prependForwardSlash(joinPaths(settings.config.base, pth));
		}
	};

	for (const route of opts.manifest.routes) {
		if (!route.prerender) continue;
		if (!route.pathname) continue;

		const outFolder = getOutFolder(opts.settings.config, route.pathname!, route.type);
		const outFile = getOutFile(opts.settings.config, outFolder, route.pathname!, route.type);
		const file = outFile.toString().replace(opts.settings.config.build.client.toString(), '');
		routes.push({
			file,
			links: [],
			scripts: [],
			styles: [],
			routeData: serializeRouteData(route, settings.config.trailingSlash),
		});
		staticFiles.push(file);
	}

	for (const route of opts.manifest.routes) {
		const pageData = internals.pagesByComponent.get(route.component);
		if (route.prerender || !pageData) continue;
		const scripts: SerializedRouteInfo['scripts'] = [];
		if (pageData.hoistedScript) {
			const hoistedValue = pageData.hoistedScript.value;
			const value = hoistedValue.endsWith('.js') ? prefixAssetPath(hoistedValue) : hoistedValue;
			scripts.unshift(
				Object.assign({}, pageData.hoistedScript, {
					value,
				})
			);
		}
		if (settings.scripts.some((script) => script.stage === 'page')) {
			const src = entryModules[PAGE_SCRIPT_ID];

			scripts.push({
				type: 'external',
				value: prefixAssetPath(src),
			});
		}

		// may be used in the future for handling rel=modulepreload, rel=icon, rel=manifest etc.
		const links: [] = [];

		const styles = pageData.styles
			.sort(cssOrder)
			.map(({ sheet }) => sheet)
			.map((s) => (s.type === 'external' ? { ...s, src: prefixAssetPath(s.src) } : s))
			.reduce(mergeInlineCss, []);

		routes.push({
			file: '',
			links,
			scripts: [
				...scripts,
				...settings.scripts
					.filter((script) => script.stage === 'head-inline')
					.map(({ stage, content }) => ({ stage, children: content })),
			],
			styles,
			routeData: serializeRouteData(route, settings.config.trailingSlash),
		});
	}

	// HACK! Patch this special one.
	if (!(BEFORE_HYDRATION_SCRIPT_ID in entryModules)) {
		// Set this to an empty string so that the runtime knows not to try and load this.
		entryModules[BEFORE_HYDRATION_SCRIPT_ID] = '';
	}

	const ssrManifest: SerializedSSRManifest = {
		adapterName: opts.settings.adapter!.name,
		routes,
		site: settings.config.site,
		base: settings.config.base,
		assetsPrefix: settings.config.build.assetsPrefix,
		markdown: settings.config.markdown,
		pageMap: null as any,
		componentMetadata: Array.from(internals.componentMetadata),
		renderers: [],
		clientDirectives: Array.from(settings.clientDirectives),
		entryModules,
		assets: staticFiles.map(prefixAssetPath),
	};

	return ssrManifest;
}

export function pluginSSR(
	options: StaticBuildOptions,
	internals: BuildInternals
): AstroBuildPlugin {
	const ssr =
		options.settings.config.output === 'server' || isHybridOutput(options.settings.config);
	return {
		build: 'ssr',
		hooks: {
			'build:before': () => {
				let vitePlugin = ssr
					? vitePluginSSR(internals, options.settings.adapter!, options.settings.config)
					: undefined;

				return {
					enforce: 'after-user-plugins',
					vitePlugin,
				};
			},
			'build:post': async ({ mutate }) => {
				if (!ssr) {
					return;
				}

				if (!internals.ssrEntryChunk) {
					throw new Error(`Did not generate an entry chunk for SSR`);
				}
				// Mutate the filename
				internals.ssrEntryChunk.fileName = options.settings.config.build.serverEntry;

				const code = await injectManifest(options, internals);
				mutate(internals.ssrEntryChunk, 'server', code);
			},
		},
	};
}

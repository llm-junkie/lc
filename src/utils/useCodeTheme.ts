/**
 * Dynamically loads the selected Prism code theme CSS.
 *
 * When `codeTheme` is 'system', auto-switches between one-dark
 * (dark base) and one-light (light base) based on the app's resolved
 * `data-base` attribute on <html>. Changes to either `data-base` or
 * `data-theme` trigger reapplication.
 *
 * All themes are statically imported so Vite can tree-shake and
 * emit the CSS files.
 */

import { useEffect, useRef } from 'react';
import { useSettings } from '../store/settings.ts';
import type { CodeTheme } from '../store/settings';

// Static CSS imports — Vite emits them as separate chunks.
import prismOneDark from 'prism-themes/themes/prism-one-dark.css?url';
import prismOneLight from 'prism-themes/themes/prism-one-light.css?url';
import prismA11yDark from 'prism-themes/themes/prism-a11y-dark.css?url';
import prismAtomDark from 'prism-themes/themes/prism-atom-dark.css?url';
import prismBase16AteliersulphurpoolLight from 'prism-themes/themes/prism-base16-ateliersulphurpool.light.css?url';
import prismCb from 'prism-themes/themes/prism-cb.css?url';
import prismColdarkCold from 'prism-themes/themes/prism-coldark-cold.css?url';
import prismColdarkDark from 'prism-themes/themes/prism-coldark-dark.css?url';
import prismCoyWithoutShadows from 'prism-themes/themes/prism-coy-without-shadows.css?url';
import prismDarcula from 'prism-themes/themes/prism-darcula.css?url';
import prismDracula from 'prism-themes/themes/prism-dracula.css?url';
import prismDuotoneDark from 'prism-themes/themes/prism-duotone-dark.css?url';
import prismDuotoneEarth from 'prism-themes/themes/prism-duotone-earth.css?url';
import prismDuotoneForest from 'prism-themes/themes/prism-duotone-forest.css?url';
import prismDuotoneLight from 'prism-themes/themes/prism-duotone-light.css?url';
import prismDuotoneSea from 'prism-themes/themes/prism-duotone-sea.css?url';
import prismDuotoneSpace from 'prism-themes/themes/prism-duotone-space.css?url';
import prismGithub from 'prism-themes/themes/prism-ghcolors.css?url';
import prismGruvboxDark from 'prism-themes/themes/prism-gruvbox-dark.css?url';
import prismGruvboxLight from 'prism-themes/themes/prism-gruvbox-light.css?url';
import prismHoliTheme from 'prism-themes/themes/prism-holi-theme.css?url';
import prismHopscotch from 'prism-themes/themes/prism-hopscotch.css?url';
import prismLucario from 'prism-themes/themes/prism-lucario.css?url';
import prismMaterialDark from 'prism-themes/themes/prism-material-dark.css?url';
import prismMaterialLight from 'prism-themes/themes/prism-material-light.css?url';
import prismMaterialOceanic from 'prism-themes/themes/prism-material-oceanic.css?url';
import prismNightOwl from 'prism-themes/themes/prism-night-owl.css?url';
import prismNord from 'prism-themes/themes/prism-nord.css?url';
import prismPojoaque from 'prism-themes/themes/prism-pojoaque.css?url';
import prismShadesOfPurple from 'prism-themes/themes/prism-shades-of-purple.css?url';
import prismSolarizedDarkAtom from 'prism-themes/themes/prism-solarized-dark-atom.css?url';
import prismSynthwave84 from 'prism-themes/themes/prism-synthwave84.css?url';
import prismVs from 'prism-themes/themes/prism-vs.css?url';
import prismVscDarkPlus from 'prism-themes/themes/prism-vsc-dark-plus.css?url';
import prismXonokai from 'prism-themes/themes/prism-xonokai.css?url';
import prismZTouch from 'prism-themes/themes/prism-z-touch.css?url';

const CSS_MAP: Record<string, string> = {
  'one-dark': prismOneDark,
  'one-light': prismOneLight,
  'a11y-dark': prismA11yDark,
  'atom-dark': prismAtomDark,
  'base16-ateliersulphurpool.light': prismBase16AteliersulphurpoolLight,
  'cb': prismCb,
  'coldark-cold': prismColdarkCold,
  'coldark-dark': prismColdarkDark,
  'coy-without-shadows': prismCoyWithoutShadows,
  'darcula': prismDarcula,
  'dracula': prismDracula,
  'duotone-dark': prismDuotoneDark,
  'duotone-earth': prismDuotoneEarth,
  'duotone-forest': prismDuotoneForest,
  'duotone-light': prismDuotoneLight,
  'duotone-sea': prismDuotoneSea,
  'duotone-space': prismDuotoneSpace,
  'github': prismGithub,
  'gruvbox-dark': prismGruvboxDark,
  'gruvbox-light': prismGruvboxLight,
  'holi-theme': prismHoliTheme,
  'hopscotch': prismHopscotch,
  'lucario': prismLucario,
  'material-dark': prismMaterialDark,
  'material-light': prismMaterialLight,
  'material-oceanic': prismMaterialOceanic,
  'night-owl': prismNightOwl,
  'nord': prismNord,
  'pojoaque': prismPojoaque,
  'shades-of-purple': prismShadesOfPurple,
  'solarized-dark-atom': prismSolarizedDarkAtom,
  'synthwave84': prismSynthwave84,
  'vs': prismVs,
  'vsc-dark-plus': prismVscDarkPlus,
  'xonokai': prismXonokai,
  'z-touch': prismZTouch,
};

/**
 * Resolve the effective code theme. 'system' → follows the app's resolved
 * light/dark BASE.
 *
 * Read `data-base`, not `data-theme`. `data-theme` is `'custom'` for every
 * custom theme, so `dataTheme === 'light'` is false even for a light-base one
 * and 'system' resolved to one-dark against a light UI. The mistake is that
 * "light theme" is expressible as an
 * attribute value OR as a resolved base, and only the base is true in both
 * cases. `data-base` is written alongside `data-theme` by every path that sets
 * it; see the `[data-base]` note in `src/index.css`.
 *
 * The `?? CSS_MAP['one-dark']` fallback covers an unknown stored value and a
 * missing `data-base` (the first paint, before ThemeProvider has applied).
 */
function resolve(codeTheme: CodeTheme, dataBase: string | null): string {
  if (codeTheme !== 'system') return CSS_MAP[codeTheme] ?? CSS_MAP['one-dark'];
  return dataBase === 'light' ? CSS_MAP['one-light'] : CSS_MAP['one-dark'];
}

/**
 * Hook: loads and swaps Prism theme CSS at runtime via a <link> element.
 */
export function useCodeTheme() {
  const codeTheme = useSettings((s) => s.codeTheme);
  const linkRef = useRef<HTMLLinkElement | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const apply = () => {
      const dataBase = document.documentElement.getAttribute('data-base');
      const href = resolve(codeTheme, dataBase);
      // console.log('[useCodeTheme] apply — codeTheme:', codeTheme, 'href:', href);

      let link = linkRef.current;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.id = 'lc-prism-theme';
        document.head.appendChild(link);
        linkRef.current = link;
      }
      if (link.href !== href) link.href = href;
    };

    apply();

    if (codeTheme === 'system') {
      // Watch BOTH attributes. `data-base` is what resolve() reads, but
      // switching between two custom themes of different bases leaves
      // `data-theme` at 'custom' the whole time — so watching `data-theme`
      // alone would miss it, and watching `data-base` alone would miss
      // nothing but costs nothing to keep.
      const obs = new MutationObserver(() => apply());
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-base', 'data-theme'],
      });
      return () => obs.disconnect();
    }
  }, [codeTheme]);
}

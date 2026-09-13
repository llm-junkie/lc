/**
 * Tiny inline icon for a file's language. Used in the user-bubble file
 * row and in the text-preview modal header. Color-coded by language
 * family (python blue, rust orange, …) for a quick visual cue.
 */

import { memo } from 'react';

const LANG_COLOR: Record<string, string> = {
  python: '#4584b6',
  typescript: '#3178c6',
  javascript: '#f7df1e',
  json: '#a0a0a0',
  html: '#e34c26',
  css: '#563d7c',
  scss: '#c69',
  sass: '#c69',
  less: '#1d365d',
  markdown: '#6a737d',
  bash: '#4eaa25',
  yaml: '#cb171e',
  toml: '#9c4221',
  sql: '#e38c00',
  rust: '#dea584',
  go: '#00add8',
  java: '#b07219',
  cpp: '#f34b7d',
  csharp: '#178600',
  php: '#4f5d95',
  ruby: '#701516',
  kotlin: '#a97bff',
  swift: '#ffac45',
  objc: '#438eff',
  c: '#555',
  dart: '#00b4ab',
  lua: '#000080',
  vim: '#199f4b',
  latex: '#3d6117',
  protobuf: '#4285f4',
  text: '#888',
  ini: '#6a737d',
};

interface Props {
  lang: string;
  size?: number;
}

export const FileTypeIcon = memo(function FileTypeIcon({ lang, size = 16 }: Props) {
  const fill = LANG_COLOR[lang] ?? '#888';
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        fill={fill}
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
        opacity="0.18"
      />
      <path
        fill="none"
        stroke={fill}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6"
      />
    </svg>
  );
});

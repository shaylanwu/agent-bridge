import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

/**
 * Agent Bridge Service 文档站（Astro + Starlight）
 *
 * 独立性：这是独立工作区，主包 `agent-bridge-service` 不依赖它，
 * 它也不进主包的 `files` 与 `npm run gate`。
 *
 * 真源在别处：契约从 ../../contracts/ 复制（sync-contracts.mjs），
 * API 参考页与消息参考页由 gen-reference.mjs 从契约生成 —— 站点不第二次描述协议，
 * 因此改了实现只要走主包的 `contracts:check` / `doc:check` 就不会与站点漂移。
 */

const SITE = 'https://shaylanwu.github.io';
const BASE = '/agent-bridge';

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    starlight({
      title: 'Agent Bridge Service',
      description:
        'Turn any local AI coding CLI into a remotely orchestrated agent — over one outbound WebSocket.',
      defaultLocale: 'en',
      locales: {
        en: { label: 'English' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/shaylanwu/agent-bridge',
        },
      ],
      // 主题：自定义 CSS 只覆盖 Starlight 暴露的变量与少量结构样式（第三版：Vue 气质）
      customCss: ['./src/styles/custom.css'],
      // 品牌：几何 logo（设备方块 → 出站连线 → 平台圆点），亮暗两个变体
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: true,
        alt: 'Agent Bridge Service',
      },
      // 代码块统一深色（亮色页上也是深色 —— Vue 文档的气质）
      expressiveCode: {
        themes: ['starlight-dark'],
      },
      // 顶栏阅读进度条（2px）；单独文件放 public/，不进打包
      head: [
        {
          tag: 'script',
          attrs: { src: '/agent-bridge/progress.js', defer: true },
        },
        {
          tag: 'script',
          attrs: { src: '/agent-bridge/hero-fit.js', defer: true },
        },
        {
          tag: 'link',
          attrs: { rel: 'icon', href: '/agent-bridge/favicon.svg', type: 'image/svg+xml' },
        },
      ],
      // 全站搜索（Pagefind，构建期索引，零服务端）。
      // 关键：API 端点内容由 gen-reference.mjs 生成静态页，所以端点名/路径/描述都能被搜到；
      // Scalar 的交互式试请求页是客户端渲染，进不了索引 —— 两者并存，各司其职。
      pagefind: true,
      sidebar: [
        {
          label: 'Get started',
          translations: { 'zh-CN': '开始使用' },
          items: ['quickstart', 'cli', 'architecture'],
        },
        {
          label: 'Protocol',
          translations: { 'zh-CN': '协议' },
          items: ['protocol/overview', 'protocol/messages', 'protocol/websocket'],
        },
        {
          label: 'Integrate',
          translations: { 'zh-CN': '对接指南' },
          items: ['integrate/platform', 'integrate/local'],
        },
        {
          label: 'API reference',
          translations: { 'zh-CN': 'API 参考' },
          items: [
            'api',
            'api/reference',
            'api/control-plane',
            'api/control-plane-reference',
          ],
        },
        {
          label: 'Changelog',
          translations: { 'zh-CN': '版本历史' },
          items: ['changelog'],
        },
      ],
      // 首页不进侧栏，走 hero 模板
      disable404Route: false,
      // 组件覆盖：顶栏右区（一级菜单 / 语言分段 / 两态主题），左区搜索保持原生位置；
      // 页脚换成站内菜单 + 版权条（首页不放「编辑此页」）
      components: {
        Header: './src/components/overrides/Header.astro',
        Footer: './src/components/overrides/Footer.astro',
        ThemeSelect: './src/components/overrides/ThemeSelect.astro',
        LanguageSelect: './src/components/overrides/LanguageSelect.astro',
      },
      editLink: {
        baseUrl: 'https://github.com/shaylanwu/agent-bridge/edit/main/site/',
      },
      lastUpdated: true,
      pagination: true,
    }),
    sitemap(),
  ],
});

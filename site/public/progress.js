/**
 * 顶栏阅读进度条（2px，主色，随滚动更新）
 *
 * 单独放在 public/ 由 astro.config 的 head 注入：不进打包、不影响 Starlight 组件结构，
 * 主题色直接用 --sl-color-accent，所以亮/暗自动跟随。
 */
(function () {
	function mount() {
		var header = document.querySelector('header.header');
		if (!header || header.querySelector('.home-progress')) return;

		var bar = document.createElement('div');
		bar.className = 'home-progress';
		if (getComputedStyle(header).position === 'static') {
			header.style.position = 'relative';
		}
		header.appendChild(bar);

		function update() {
			var el = document.scrollingElement || document.documentElement;
			var max = el.scrollHeight - el.clientHeight;
			var ratio = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
			bar.style.width = ratio * 100 + '%';
		}

		update();
		window.addEventListener('scroll', update, { passive: true });
		window.addEventListener('resize', update);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mount);
	} else {
		mount();
	}
	// 站内切换页面后重新挂一次
	document.addEventListener('astro:after-swap', mount);
})();

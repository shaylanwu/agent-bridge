/**
 * 描述（.tagline）的换行宽度与标题（h1）严格同宽：
 * 纯 CSS 的 fit-content 会取"最宽子元素"，而描述的自然行宽通常大于标题，
 * 无法表达"宽度只由标题决定"。这段脚本把标题的实际渲染宽度写到描述的
 * max-width 上 —— 标题换文字、改字号、窗口缩放都自动跟随。
 */
(function () {
  function fit() {
    document.querySelectorAll('.hero').forEach(function (hero) {
      var h1 = hero.querySelector('h1');
      var tag = hero.querySelector('.tagline');
      if (!h1 || !tag) return;
      tag.style.maxWidth = Math.round(h1.getBoundingClientRect().width) + 'px';
    });
  }

  function mount() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fit);
    } else {
      fit();
    }
    window.addEventListener('resize', fit);
  }

  mount();
  document.addEventListener('astro:after-swap', mount);
})();

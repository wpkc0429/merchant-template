/* ============================================================
   content.js — DESIGN LAYER: static copy and design constants.

   Everything here is text / art-direction that is NOT in the platform API
   (yet). It lives in this one module so it is easy to find and, later, to
   drive from CMS fields instead. Edit freely; the commerce layer
   (public/commerce/**) and public/config.js are not involved.

   Catalogue data (products, prices, images, subtitles, categories,
   featured picks) does NOT belong here: it comes from the API.

   Static ASSET exception: `storyImage` below is brand photography for the
   story sections, not a product image, so it stays in public/assets/.

   PLACEHOLDER CONTENT: every string here is generic template copy. A real
   merchant replaces it (scripts/new-merchant.mjs sets brand.name and
   store.name from --name).
   ============================================================ */
window.SHOP_CONTENT = {
  // Visual accent (written to --accent at boot). One neutral accent; the
  // palette tokens live in styles.css.
  accent: '#2f5d8a',

  // Brand name shown in the header and the footer.
  brand: { name: '你的商店', footer: '你的商店' },

  // Search box placeholder and the label of the optional per-item note.
  searchPlaceholder: '搜尋商品…',
  noteLabel: '商品備註',

  // Title of the home-page featured block (its products come from the
  // category whose slug is SHOP_CONFIG.featuredCategory, default new-arrivals).
  featuredTitle: '本季新品',

  // Story photography (public/assets/story.png). Not from the API.
  storyImage: 'assets/story.png',

  hero: {
    eyebrow: 'NEW COLLECTION',
    title: '簡單，\n剛剛好',
    lede: '這裡是你的商店首頁標語，請換成自己的文字。'
  },

  storyTeaser: {
    eyebrow: 'ABOUT US',
    title: '關於\n你的商店',
    lede: '用幾句話介紹你的品牌與理念。'
  },

  story: {
    eyebrow: 'ABOUT US',
    title: '關於\n你的商店',
    paragraphs: [
      '這是品牌故事的第一段，請換成你想對顧客說的話。',
      '第二段可以介紹你的選品原則、製作方式或服務承諾。'
    ]
  },

  instagram: { handle: '@your_shop' },

  store: {
    name: '你的商店',
    address: '（請填寫店面地址）',
    addressShort: '（店面地址）',
    hours: '10:00 – 18:00 · 週日休',
    hoursShort: '10:00–18:00',
    tel: '00-0000-0000'
  },

  newsletter: {
    title: '訂閱電子報，取得新品與活動通知',
    success: '訂閱成功，感謝你的支持。'
  },

  // Mobile home promo strip.
  promo: { title: '會員專屬優惠', sub: '請填寫活動說明', cta: '了解' },

  // Header links that are pages, not categories (categories come from the API).
  navPages: [
    { label: '關於我們', route: 'story' },
    { label: '門市與配送', route: 'store' }
  ],

  sorts: ['推薦', '價格低→高', '價格高→低'],

  faq: [
    { q: '配送與到貨時間', a: '這裡填寫配送範圍與預計到貨時間。' },
    { q: '退換貨說明', a: '這裡填寫退換貨條件與流程。' },
    { q: '付款方式', a: '這裡填寫可用的付款方式。' }
  ],

  // Product detail accordion (same for every product until it moves to the API).
  pinfo: [
    { q: '商品規格', a: '這裡填寫共通的商品規格說明。' },
    { q: '配送與保養', a: '這裡填寫共通的配送、使用或保養說明。' }
  ]
};

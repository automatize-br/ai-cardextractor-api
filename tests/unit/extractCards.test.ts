import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractRawCards, parsePriceToCents } from '../../src/modules/extraction/extractCards.ts'

const amazonHtml = `<!doctype html><html><body>
<div class="s-result-item">
  <a href="/Fone-JBL/dp/B0ABCDEFGH/ref=sr_1_1"><h2>Fone Bluetooth JBL Tune 510BT</h2></a>
  <img class="s-image" src="https://m.media-amazon.com/images/I/x.jpg" />
  <span class="a-price"><span class="a-offscreen">R$ 199,90</span></span>
</div>
</body></html>`

const mlHtml = `<!doctype html><html><body>
<div class="ui-search-result">
  <a href="https://produto.mercadolivre.com.br/MLB-123456789-fone-jbl"><h2>Fone Bluetooth JBL Tune 510BT</h2></a>
  <img src="https://http2.mlstatic.com/D_NQ_NP_2X_123-O.jpg" />
  <span class="andes-money-amount">R$ 249,90</span>
</div>
</body></html>`

const shopeeHtml = `<!doctype html><html><body>
<div class="shopee-search-item">
  <a href="/Fone-JBL-i.123456.789012"><div class="line-clamp-2">Fone Bluetooth JBL Tune 510BT</div></a>
  <img data-sqe="img" src="https://cf.shopee.com.br/file/abc" />
  <div data-sqe="price">R$ 179,90</div>
</div>
</body></html>`

test('parsePriceToCents entende formatos BR/US', () => {
  assert.equal(parsePriceToCents('R$ 1.299,90'), 129990)
  assert.equal(parsePriceToCents('1,299.90'), 129990)
  assert.equal(parsePriceToCents('12,50'), 1250)
  assert.equal(parsePriceToCents('sem preço'), null)
})

test('extrai card Amazon por DOM', () => {
  const { cards } = extractRawCards(amazonHtml, 'amazon', 'https://www.amazon.com.br/ofertas', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.externalProductId, 'B0ABCDEFGH')
  assert.equal(cards[0]?.title, 'Fone Bluetooth JBL Tune 510BT')
  assert.equal(cards[0]?.priceCents, 19990)
  assert.equal(cards[0]?.currency, 'BRL')
  assert.equal(cards[0]?.imageUrl, 'https://m.media-amazon.com/images/I/x.jpg')
})

test('extrai card Mercado Livre por DOM', () => {
  const { cards } = extractRawCards(mlHtml, 'mercadolivre', 'https://lista.mercadolivre.com.br/fone', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.externalProductId, 'MLB-123456789')
  assert.equal(cards[0]?.priceCents, 24990)
})

test('Mercado Livre: fração + centavos em spans vira preço correto (199,90)', () => {
  const html = `<!doctype html><html><body>
<div class="ui-search-result">
  <a href="https://produto.mercadolivre.com.br/MLB-123456789-fone-jbl"><h2>Fone Bluetooth JBL Tune 510BT</h2></a>
  <img data-src="https://http2.mlstatic.com/D_NQ_NP_2X_123-O.jpg" src="data:image/gif;base64,R0lGOD" />
  <span class="andes-money-amount">
    <span class="andes-money-amount__currency-symbol">R$</span>
    <span class="andes-money-amount__fraction">199</span>
    <span class="andes-money-amount__cents">90</span>
  </span>
</div>
</body></html>`
  const { cards } = extractRawCards(html, 'mercadolivre', 'https://lista.mercadolivre.com.br/fone', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.priceCents, 19990)
  assert.equal(cards[0]?.imageUrl, 'https://http2.mlstatic.com/D_NQ_NP_2X_123-O.jpg')
  // Evidência é o texto VERBATIM do DOM (sem vírgula reconstruída).
  assert.equal(cards[0]?.priceQuote?.replace(/\s+/g, ''), 'R$19990')
})

test('extrai card Shopee por DOM', () => {
  const { cards } = extractRawCards(shopeeHtml, 'shopee', 'https://shopee.com.br/search?keyword=fone', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.externalProductId, '123456')
  assert.equal(cards[0]?.priceCents, 17990)
})

test('dois cards ML: segundo sem símbolo R$ não herda título/preço do primeiro', () => {
  const html = `<!doctype html><html><body>
<li class="ui-search-layout__item">
  <a href="https://produto.mercadolivre.com.br/MLB-1111111111-fone"><h2>Fone Bluetooth JBL</h2></a>
  <img src="https://http2.mlstatic.com/1-I.jpg" />
  <span class="andes-money-amount"><span class="andes-money-amount__fraction">199</span><span class="andes-money-amount__cents">90</span></span>
</li>
<li class="ui-search-layout__item">
  <a href="https://produto.mercadolivre.com.br/MLB-2222222222-caixa"><h2>Caixa de Som JBL Go 3</h2></a>
  <img data-src="https://http2.mlstatic.com/2-I.jpg" />
  <span class="andes-money-amount"><span class="andes-money-amount__fraction">249</span><span class="andes-money-amount__cents">50</span></span>
</li>
</body></html>`
  const { cards } = extractRawCards(html, 'mercadolivre', 'https://lista.mercadolivre.com.br/ofertas', 200)
  assert.equal(cards.length, 2)
  assert.equal(cards[0]?.title, 'Fone Bluetooth JBL')
  assert.equal(cards[0]?.priceCents, 19990)
  assert.equal(cards[1]?.title, 'Caixa de Som JBL Go 3')
  assert.equal(cards[1]?.priceCents, 24950)
})

test('JSON-LD tem prioridade sobre DOM e o DOM complementa a cobertura', () => {
  const html = `<!doctype html><html><head>
  <script type="application/ld+json">{"@type":"Product","name":"Produto JSON-LD Completo","url":"https://loja.com/p/1","image":"https://loja.com/img.jpg","offers":{"price":"99.90","priceCurrency":"BRL"}}</script>
  </head><body>${amazonHtml}</body></html>`
  const { cards } = extractRawCards(html, 'amazon', 'https://www.amazon.com.br', 200)
  assert.equal(cards.length, 2)
  assert.equal(cards[0]?.title, 'Produto JSON-LD Completo')
  assert.equal(cards[0]?.priceCents, 9990)
  assert.equal(cards[1]?.title, 'Fone Bluetooth JBL Tune 510BT')
})

test('AliExpress: lê itemList de window._dida_config_._init_data_', () => {
  const html = `<!doctype html><html><body><script>
window._dida_config_._init_data_= { data: {"itemList":{"content":[
{"productId":"1005001234567890","title":{"displayTitle":"Fone Bluetooth TWS Pro"},"image":{"imgUrl":"//ae-pic-a1.aliexpress-media.com/kf/a.jpg"},"prices":{"salePrice":{"currencyCode":"BRL","cent":2990,"formattedPrice":"R$ 29,90"},"originalPrice":{"cent":5990}}},
{"productId":"1005009876543210","title":{"displayTitle":"Caixa de Som Bluetooth Portátil"},"image":{"imgUrl":"//ae-pic-a1.aliexpress-media.com/kf/b.jpg"},"prices":{"salePrice":{"currencyCode":"BRL","cent":15990,"formattedPrice":"R$ 159,90"}}}
]}} }
</script></body></html>`
  const { cards } = extractRawCards(html, 'aliexpress', 'https://www.aliexpress.com/w/wholesale-fone-bluetooth.html', 200)
  assert.equal(cards.length, 2)
  assert.equal(cards[0]?.externalProductId, '1005001234567890')
  assert.equal(cards[0]?.title, 'Fone Bluetooth TWS Pro')
  assert.equal(cards[0]?.priceCents, 2990)
  assert.equal(cards[0]?.originalPriceCents, 5990)
  assert.equal(cards[0]?.currency, 'BRL')
  assert.equal(cards[0]?.permalink, 'https://www.aliexpress.com/item/1005001234567890.html')
  assert.equal(cards[0]?.imageUrl, 'https://ae-pic-a1.aliexpress-media.com/kf/a.jpg')
})

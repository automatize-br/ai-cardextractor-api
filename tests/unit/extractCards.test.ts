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

const temuHtml = `<!doctype html><html><body>
<div class="goods-2xIL4">
  <a href="https://www.temu.com/fone-bluetooth-g-60109999999999.html"><h3>Fone Bluetooth TWS Pro</h3></a>
  <img class="imgWrap-1cwSB" src="https://img.kwcdn.com/product/x.jpg" />
  <span class="goodsPrice-abc">R$ 89,90</span>
</div>
</body></html>`

test('extrai card Temu por DOM (âncora -g-<id>)', () => {
  const { cards } = extractRawCards(temuHtml, 'temu', 'https://www.temu.com/search_result.html?search_key=fone', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.externalProductId, '60109999999999')
  assert.equal(cards[0]?.title, 'Fone Bluetooth TWS Pro')
  assert.equal(cards[0]?.priceCents, 8990)
  assert.equal(cards[0]?.currency, 'BRL')
})

test('lojas BR usam heurística: âncora /p/ vira card (Magalu)', () => {
  const html = `<!doctype html><html><body>
<div data-testid="product-card">
  <a href="https://www.magazineluiza.com.br/fone-bluetooth/p/ab1234/"><h3>Fone Bluetooth TWS</h3></a>
  <img src="https://a-static.mlcdn.com.br/x.jpg" />
  <span class="price-template">R$ 149,90</span>
</div>
</body></html>`
  const { cards } = extractRawCards(html, 'magalu', 'https://www.magazineluiza.com.br/busca/fone/', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.title, 'Fone Bluetooth TWS')
  assert.equal(cards[0]?.priceCents, 14990)
})

const sheinJsonLdHtml = `<!doctype html><html><body>
<script type="application/ld+json" data-sheinprivacy="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"ItemList","numberOfItems":1,"itemListElement":[{"@type":"ListItem","position":1,"item":{"@type":"Product","name":"Fone De Ouvido Sem Fio TWS Com Tela LED","url":"https://br.shein.com/-Fone-Tws-p-53459302.html","image":"https://img.ltwebstatic.com/x.png","sku":"53459302","offers":{"@type":"Offer","url":"/-Fone-Tws-p-53459302.html","price":"17.42","priceCurrency":"BRL"}}}]}]}</script>
</body></html>`

test('extrai card Shein de JSON-LD ItemList/itemListElement', () => {
  const { cards } = extractRawCards(sheinJsonLdHtml, 'shein', 'https://br.shein.com/pdsearch/fone/', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.externalProductId, '53459302')
  assert.equal(cards[0]?.priceCents, 1742)
  assert.equal(cards[0]?.currency, 'BRL')
})

const magaluTestIdHtml = `<!doctype html><html><body>
<div><a href="/fone-bluetooth-tws/p/abc123/ea/fobt/"><div data-testid="product-card-media-content"><img src="https://a-static.mlcdn.com.br/x.jpeg" /></div><div data-testid="card-content"><h3 data-testid="product-card-title">Fone Bluetooth TWS Pro</h3><p data-testid="product-card-price-final"><span>Preço R$ 89,90</span></p></div></a></div>
</body></html>`

test('extrai card Magalu por data-testid (classes utilitárias sem "price")', () => {
  const { cards } = extractRawCards(magaluTestIdHtml, 'magalu', 'https://www.magazineluiza.com.br/busca/fone/', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.title, 'Fone Bluetooth TWS Pro')
  assert.equal(cards[0]?.priceCents, 8990)
})

const dafitiHtml = `<!doctype html><html><body>
<div class="product-box" data-sku="SA232SHF85XMS"><div class="product-box-image"><a href="https://www.dafiti.com.br/Tenis-Feminino-Santa-Lolla-15148814.html" class="product-box-link"><img src="https://static.dafiti.com.br/x.jpg" /></a></div><div class="product-box-title">Tênis Feminino Santa Lolla Casual</div><div class="product-box-price-to">R$ 186,99</div><div class="product-box-price-from">R$ 249,90</div></div>
</body></html>`

test('extrai card Dafiti (box dedicado, preço de/por)', () => {
  const { cards } = extractRawCards(dafitiHtml, 'dafiti', 'https://www.dafiti.com.br/catalog/?q=fone', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.externalProductId, '15148814')
  assert.equal(cards[0]?.priceCents, 18699)
  assert.equal(cards[0]?.originalPriceCents, 24990)
})

// REGRESSÃO (prod 16/11/2026): o card da busca Amazon traz a PARCELA dentro de
// `.a-price` ("em até 10x de R$ 148,05 sem juros"). O pipeline escolhia o MENOR
// candidato como preço atual → "De R$ 3.299,00 por R$ 148,05 · 96% OFF".
const amazonInstallmentHtml = `<!doctype html><html><body>
<div data-component-type="s-search-result">
  <a href="https://www.amazon.com.br/Celular-Samsung-Galaxy-A37/dp/B0GVSZXP9M/ref=sr_1_1">
    <img class="s-image" src="https://m.media-amazon.com/images/I/a37.jpg" />
    <h2><span>Celular Samsung Galaxy A37 5G 128GB, 6GB RAM, Câmera 50MP</span></h2>
    <span class="a-price a-text-price"><span class="a-offscreen">R$ 3.299,00</span></span>
    <span class="a-price"><span class="a-offscreen">R$ 1.480,50</span></span>
    <span class="a-size-base a-color-secondary">em até 10x de <span class="a-price"><span class="a-offscreen">R$ 148,05</span></span> sem juros</span>
  </a>
</div>
</body></html>`

test('Amazon: parcela ("10x de R$ 148,05") NÃO vira preço atual', () => {
  const { cards } = extractRawCards(amazonInstallmentHtml, 'amazon', 'https://www.amazon.com.br/s?k=Celulares', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.priceCents, 148050, 'preço atual = à vista (R$ 1.480,50), não a parcela')
  assert.equal(cards[0]?.originalPriceCents, 329900)
})

test('Amazon: preço "/mês" também é ignorado como preço atual', () => {
  const html = `<!doctype html><html><body>
<div data-component-type="s-search-result">
  <a href="https://www.amazon.com.br/produto/dp/B0MONTH001">
    <img class="s-image" src="https://m.media-amazon.com/images/I/m.jpg" />
    <h2><span>Smartwatch Amazfit Bip 6 GPS</span></h2>
    <span class="a-price"><span class="a-offscreen">R$ 529,00</span></span>
    <span class="a-size-base">R$ 44,08/mês com cartão</span>
  </a>
</div>
</body></html>`
  const { cards } = extractRawCards(html, 'amazon', 'https://www.amazon.com.br/s?k=Games', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.priceCents, 52900)
})

test('filtro de parcela é SÓ da Amazon: em outra loja o comportamento antigo permanece', () => {
  // Card com DOIS valores no mesmo seletor: preço cheio + "12x de R$ ...".
  // Com o filtro (opt-in) vazando para outras lojas, o resultado mudaria; o
  // comportamento fora da Amazon tem de ficar EXATAMENTE como antes (menor
  // candidato = preço atual).
  const html = `<!doctype html><html><body>
<div class="shopee-card" data-sqe="item">
  <a href="https://shopee.com.br/Fone-Bluetooth-i.123.456">
    <img data-sqe="img" src="https://cf.shopee.com.br/x.jpg" />
    <div class="line-clamp-2">Fone Bluetooth TWS Pro</div>
    <div class="truncate">R$ 199,90</div>
    <div class="truncate">12x de R$ 16,66</div>
  </a>
</div>
</body></html>`
  const { cards } = extractRawCards(html, 'shopee', 'https://shopee.com.br/search?keyword=fone', 200)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.priceCents, 1666, 'fora da Amazon nada muda (menor candidato segue como atual)')
  assert.equal(cards[0]?.originalPriceCents, 19990)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import ExtractionService from '../../src/modules/extraction/extractionService.ts'

function amazonCard(id: string, title: string, price: string): string {
  return `<div class="s-result-item">
  <a href="/produto/dp/${id}"><h2>${title}</h2></a>
  <img class="s-image" src="https://m.media-amazon.com/images/I/${id}.jpg" />
  <span class="a-price"><span class="a-offscreen">${price}</span></span>
</div>`
}

const html = `<html><body>
${amazonCard('B0AAAAAAA1', 'Fone Bluetooth JBL Tune 510BT', 'R$ 199,90')}
${amazonCard('B0AAAAAAA2', 'Caixa de Som JBL Go 3', 'R$ 249,90')}
${amazonCard('B0AAAAAAA3', 'Headset Gamer HyperX Cloud II', 'R$ 399,90')}
</body></html>`

test('cobertura: cards além do limite do LLM caem no determinístico', async () => {
  const result = await ExtractionService.extract({
    marketplace: 'amazon',
    url: 'https://www.amazon.com.br/ofertas',
    html,
    profile: 'cards',
    maxScanned: 200,
    maxCards: 200,
    maxLlmCards: 2,
    mode: 'off',
  })
  assert.equal(result.cards.length, 3)
  assert.equal(result.rejected.length, 0)
  assert.deepEqual(
    result.cards.map((card) => card.cardId),
    ['c1', 'c2', 'c3'],
  )
  assert.equal(result.coverageComplete, true)
  assert.equal(result.quality, 'ok')
})

test('maxCards limita a saída e marca parcial', async () => {
  const result = await ExtractionService.extract({
    marketplace: 'amazon',
    url: 'https://www.amazon.com.br/ofertas',
    html,
    profile: 'cards',
    maxScanned: 200,
    maxCards: 2,
    maxLlmCards: 0,
    mode: 'off',
  })
  assert.equal(result.cards.length, 2)
  assert.equal(result.quality, 'partial')
  assert.equal(result.coverageComplete, false)
})

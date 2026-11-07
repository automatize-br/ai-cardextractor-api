import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isMarketplaceHost,
  isScrapeMarketplace,
  SCRAPE_MARKETPLACES,
} from '../../src/config/marketplaces.ts'
import { SUPPORTED_PLATFORMS } from '../../src/config/version.ts'

// ============================================================================
// Cobertura do pool: TODO o scrape de ofertas roda no worker. A API principal
// nunca busca HTML — então o allowlist aqui precisa cobrir todas as lojas com
// coleta por scrape (as oficiais por chave/senha, ex. Shopee, ficam na API).
// ============================================================================

const EXPECTED = [
  'amazon',
  'mercadolivre',
  'shopee',
  'aliexpress',
  'shein',
  'temu',
  'tiktokshop',
  'magalu',
  'netshoes',
  'casasbahia',
  'pontofrio',
  'americanas',
  'kabum',
  'centauro',
  'renner',
  'riachuelo',
  'dafiti',
  'zattini',
  'boticario',
]

test('allowlist cobre todas as lojas de scrape (19)', () => {
  assert.deepEqual([...SCRAPE_MARKETPLACES].sort(), [...EXPECTED].sort())
  assert.deepEqual([...SUPPORTED_PLATFORMS].sort(), [...EXPECTED].sort())
})

test('cada loja do allowlist é reconhecida como scrape marketplace', () => {
  for (const marketplace of EXPECTED) {
    assert.equal(isScrapeMarketplace(marketplace), true, marketplace)
  }
  assert.equal(isScrapeMarketplace('olx'), false)
})

test('hosts canônicos passam no anti-SSRF', () => {
  const hosts: Array<[string, string]> = [
    ['temu', 'www.temu.com'],
    ['tiktokshop', 'shop.tiktok.com'],
    ['magalu', 'www.magazineluiza.com.br'],
    ['netshoes', 'www.netshoes.com.br'],
    ['casasbahia', 'www.casasbahia.com.br'],
    ['pontofrio', 'www.pontofrio.com.br'],
    ['americanas', 'www.americanas.com.br'],
    ['kabum', 'www.kabum.com.br'],
    ['centauro', 'www.centauro.com.br'],
    ['renner', 'www.lojasrenner.com.br'],
    ['riachuelo', 'www.riachuelo.com.br'],
    ['dafiti', 'www.dafiti.com.br'],
    ['zattini', 'www.zattini.com.br'],
    ['boticario', 'www.boticario.com.br'],
    ['amazon', 'www.amazon.com.br'],
    ['aliexpress', 'pt.aliexpress.com'],
    ['shein', 'br.shein.com'],
  ]
  for (const [marketplace, host] of hosts) {
    assert.equal(isMarketplaceHost(marketplace, host), true, `${marketplace}:${host}`)
  }
})

test('host estranho não passa (anti-SSRF)', () => {
  assert.equal(isMarketplaceHost('temu', 'temu.evil.com'), false)
  assert.equal(isMarketplaceHost('magalu', 'evil-magazineluiza.com.br'), false)
  assert.equal(isMarketplaceHost('olx', 'www.olx.com.br'), false)
})

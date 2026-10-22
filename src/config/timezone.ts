// Fixa o fuso do processo antes de qualquer Date/formatacao. Deve ser o
// primeiro import do server.
process.env['TZ'] = process.env['TZ'] || 'America/Sao_Paulo'

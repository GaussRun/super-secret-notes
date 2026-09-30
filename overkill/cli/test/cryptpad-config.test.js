// Instance config parsing for the experimental CryptPad backend (no vendored modules needed).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetchApiConfig, fetchAppConfig } from '../src/backends/cryptpad/config.js'

let server
let origin
const routes = {}
before(async () => {
  server = http.createServer((req, res) => {
    const body = routes[req.url]
    res.statusCode = body === undefined ? 404 : 200
    res.end(body ?? 'not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

test('defaults for websocketPath and fileHost when the instance leaves them out', async () => {
  routes['/api/config'] = 'define(function(){;\nreturn {\n\t"httpUnsafeOrigin": "x", "restrictRegistration": false\n};\n});'
  const c = await fetchApiConfig(origin)
  assert.equal(c.websocketPath, origin.replace('http', 'ws') + '/cryptpad_websocket')
  assert.equal(c.fileHost, origin)
  assert.equal(c.restrictRegistration, false)
  routes['/api/config'] = 'define(function(){;\nreturn {"websocketPath": "wss://api.example/ws", "fileHost": "https://files.example"};\n});'
  const d = await fetchApiConfig(origin)
  assert.equal(d.websocketPath, 'wss://api.example/ws')
  assert.equal(d.fileHost, 'https://files.example')
})

test('loginSalt and minimum password length from application_config.js', async () => {
  routes['/customize/application_config.js'] = "define(['/common/application_config_internal.js'], function (AppConfig) {\n    AppConfig.loginSalt = 'GRg1QAZ6jTUS';\n    AppConfig.minimumPasswordLength = 14;\n    return AppConfig;\n});"
  assert.deepEqual(await fetchAppConfig(origin), { loginSalt: 'GRg1QAZ6jTUS', minimumPasswordLength: 14 })
  delete routes['/customize/application_config.js']
  assert.deepEqual(await fetchAppConfig(origin), { loginSalt: '', minimumPasswordLength: 8 })
})

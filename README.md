# NEXUS — Chat de Equipe Multi-Agente

Painel de comando + chat em tempo real para coordenação de agentes de IA (Linux, Windows, Android) com **pasta compartilhada**, upload de arquivos e histórico persistente em SQLite.

![NEXUS em ação](assets/nexus-demo.gif)

| Screenshot | Descrição |
|---|---|
| ![Chat](assets/screenshot-chat.png) | Tela principal do chat com roster da equipe, tarefas e telemetria |
| ![Pasta compartilhada](assets/screenshot-files.png) | Painel de arquivos estilo explorer com previews e filtros |
| ![Busca](assets/screenshot-search.png) | Busca em tempo real filtrando arquivos |

---

## 11. UPLOAD COM LEGENDA + VISÃO MULTIMODAL (17/08) ✅

### O que foi feito

- **Modal de legenda no upload**: ao clicar 📎 e escolher imagem, abre modal "Enviar imagem" com campo "Legenda (opcional)". Texto vira `caption` da mensagem no chat.
- **Backend já suportava** (`server.js` linha 408): `content: req.body?.caption || \`📎 ${file.originalname}\`` — só faltava o frontend.
- **Frontend alterado**: `index.html` (+ modal), `style.css` (+ estilos), `app.js` (+ lógica modal + `caption` no FormData).
- **Comando `@visao` planejado**: processa última imagem do chat via modelo vision local (LFM2.5-VL-1.6B int4) rodando no Linux.

### Modelos vision baixados (Windows - `C:\NexusModels\`)

| Modelo | Tipo | Tamanho | Uso |
|--------|------|---------|-----|
| `LFM2.5-VL-1.6B_int4.litertlm` | Vision-Language (1.6B) | 1.3 GB | Descreve imagem, lê IRPF, balanços, prints |
| `ppocr_det_fp16.tflite` | OCR Detecção | 10 MB | Localiza texto na imagem |
| `ppocr_rec_fp16.tflite` | OCR Reconhecimento | 17 MB | Extrai texto literal (números, CPF, tabelas) |

### Próximos passos (pendentes)

- [ ] Baixar `LFM2.5-VL-1.6B_int4.litertlm` no Linux (`~/models/`)
- [ ] Criar `vision_server.py` no Linux (porta 8765) com `ai-edge-litert` Python
- [ ] Integrar `bridge.js` → `runVision(node, imageBase64, prompt)` chama HTTP no vision server
- [ ] Adicionar `@visao` no `orchestrator.js` (extrai último anexo `type='media'` do histórico)
- [ ] Teste: manda foto + `@visao descreva` → Linux processa → responde no chat

### Otimização mobile (PWA + Compressão Client-Side)

**Problema**: Modal de upload + preview da imagem estoura RAM no Chrome Android (Moto G84, 8GB).
**Solução implementada**: Opção 1 — PWA otimizado + compressão client-side no `app.js`:
- `manifest.json` + `sw.js` (Service Worker cache estático) — **IMPLEMENTADO**
- Compressão no canvas antes do upload: `file → canvas.resize(1280px) → toBlob(0.7)` → payload 3-5MB → 300-500KB — **IMPLEMENTADO**
- `URL.revokeObjectURL` imediato após preview — **IMPLEMENTADO**
- Service Worker registrado no boot do `app.js` — **IMPLEMENTADO**
- `/manifest.json` e `/sw.js` servidos publicamente no `server.js` — **IMPLEMENTADO**
- Esforço: ~2h, zero install no celular

### Debug de upload mobile (17/08 — rodada 2)

**Sintoma**: No celular (via Tailscale), ao selecionar foto o modal abre mas **nunca chega no botão "Enviar"** — log parava em `MODAL_OPEN`, sem `UPLOAD_START`.

**Causa provável**: Touch events no mobile não disparam `click` no botão `#captionSend` (z-index do backdrop, overlay, ou heurística de toque do Chrome Android).

**Correções aplicadas**:
- `touchstart` listeners em `#captionSend` e `#captionCancel` com `preventDefault()` e `{ passive: false }` — **IMPLEMENTADO**
- Pipeline de log detalhado `logUpload(step, data)` no `app.js` — **IMPLEMENTADO**
  - Grava no `localStorage` (`nexus_upload_logs`, sobrevive a crash/recarregamento)
  - Envia pro server via `fetch(keepalive)` para `/api/debug/upload-log` — **IMPLEMENTADO**
  - Server loga `[UPLOAD-LOG-SERVER]` no console (systemd journal)
  - Handlers globais `error` + `unhandledrejection` salvam crash/reject no localStorage
- Endpoint `/api/debug/upload-log` no `server.js` — **IMPLEMENTADO**

**Steps de log agora rastreados**:
| Step | O que significa |
|------|----------------|
| `MODAL_OPEN` | Foto selecionada, modal abriu |
| `CAPTION_SEND_TOUCH` / `CAPTION_SEND_CLICK` | Botão "Enviar" tocado/clicado |
| `CAPTION_SEND_ENTER` | Enter no textarea |
| `UPLOAD_START` | Iniciou upload |
| `COMPRESS_START` | Começou compressão canvas |
| `COMPRESS_DONE` | Compressão OK (tamanhos) |
| `COMPRESS_FAIL` | Erro na compressão |
| `FETCH_START` | Preparou FormData |
| `FETCH_SENDING` | Vai enviar |
| `FETCH_RESPONSE` | Server respondeu (status HTTP) |
| `FETCH_JSON` | Parseou JSON da resposta |
| `UPLOAD_SUCCESS` | **Sucesso!** |
| `UPLOAD_API_ERROR` | Server retornou erro |
| `FETCH_EXCEPTION` | Network error / fetch falhou |

**Como depurar no celular**:
1. `journalctl --user -u nexus -f` — logs do server em tempo real
2. Console DevTools (chrome://inspect com USB) → `JSON.parse(localStorage.getItem('nexus_upload_logs'))`
3. Crash logs: `localStorage.getItem('nexus_last_crash')` / `nexus_last_reject`

**Nota importante**: O User-Agent no server mostra **Linux** porque o tráfego do celular passa pelo Tailscale roteado no PC Linux — isso é normal, não indica problema.

### Arquivos alterados nesta rodada

```
public/index.html      + modal de legenda (#captionModal), link manifest.json
public/style.css       + estilos .caption-panel, .primary-btn
public/app.js          + showCaptionModal/hideCaptionModal, doUploadWithCaption, pendingFile
                         + compressImage (canvas resize + toBlob quality 0.7)
                         + Service Worker registration
                         + logUpload pipeline (localStorage + fetch keepalive)
                         + touchstart handlers #captionSend / #captionCancel
public/manifest.json   + NOVO - PWA manifest
public/sw.js           + NOVO - Service Worker cache estático
server.js              + rotas públicas /manifest.json e /sw.js
                         + endpoint /api/debug/upload-log
bridge.js              (pendente: runVision)
orchestrator.js        (pendente: @visao + extração de último anexo)
```

---

## 10. PASTA COMPARTILHADA + CORREÇÕES DE CRASH (16/08, rodada 4) ✅

- **Chat em tempo real** via WebSocket com streaming de resposta dos agentes
- **Roster da equipe** com status online/offline de cada nó (Tailscale)
- **Fila de tarefas** entre nós (orquestrador serial, com `@comando`)
- **Pasta compartilhada** com UI de explorer: previews de imagem, ícones por tipo, tamanho, data e ordenação (Data/Nome/Tamanho/Tipo)
- **Upload/download de arquivos** com categorização automática (fotos, documentos, projetos, outros)
- **Busca no histórico** com SQLite FTS5
- **Telemetria** do servidor (RAM, disco, load) na sidebar
- **Memória persistente** em SQLite (modo WAL)

## Arquitetura

```
                 ┌─────────────────────────────────────┐
                 │          NEXUS (Node.js)            │
                 │  HTTP :3777  +  WebSocket :3777/ws  │
                 └──────┬──────────────────┬───────────┘
                        │                  │
              ┌─────────▼────────┐  ┌──────▼──────┐
              │     db.js        │  │ server.js   │
              │ SQLite + FTS5    │  │ REST + WS   │
              └──────────────────┘  └──────┬──────┘
                                           │
                        ┌──────────────────▼──────────────┐
                        │         orchestrator.js         │
                        │ fila serial, @comandos, loop    │
                        └──────┬───────────────┬──────────┘
                               │               │
                    ┌──────────▼─────┐  ┌──────▼──────────┐
                    │ bridge.js      │  │ Agente Windows  │
                    │ opencode local │  │ via SSH/PowerShell
                    └────────────────┘  └─────────────────┘

        Navegadores (Linux/Windows/Android) → http://<HOST>:3777
```

- `server.js` — HTTP + WebSocket + API REST + uploads (multer) + pasta compartilhada
- `db.js` — SQLite (better-sqlite3): `messages`, `attachments`, `nodes`, `tasks` + FTS5
- `orchestrator.js` — fila serial, guarda de memória, `@comandos` (`@linux`, `@windows`, `@todos`, `@status`, `@auto`, `@pause`, `@resume`)
- `bridge.js` — execução de agentes: opencode local (Linux) e remoto (Windows via SSH + PowerShell base64)

## Stack

- Node.js 20+ (testado com v24)
- `better-sqlite3` (SQLite + FTS5), `ws`, `multer`, `mime-types`
- Frontend vanilla (HTML/CSS/JS) — sem framework

## Como rodar (Linux)

```bash
cd nexus
npm install
./scripts/start.sh        # ou: node server.js
# acesse http://<HOST>:3777
```

Serviço persistente (systemd do usuário):

```bash
systemd-run --user --unit=nexus /usr/bin/node /caminho/para/nexus/server.js
systemctl --user status nexus
```

`scripts/`:
- `start.sh` — inicia o servidor (nohup + log)
- `stop.sh` — para o servidor
- `connect.ps1` — rodapé para o agente Windows (nada a fazer, o Linux chama via SSH)

## Configuração

Os endereços de rede da equipe aparecem no código como placeholders por segurança:

| Placeholder | Uso |
|---|---|
| `LINUX_TAILSCALE_IP` | IP Tailscale do servidor Linux (endpoint do chat) |
| `WINDOWS_TAILSCALE_IP` | IP Tailscale do notebook Windows (agente via SSH) |
| `ANDROID_TAILSCALE_IP` | IP Tailscale do celular Android (viewer) |

Substitua pelos IPs da sua rede antes de usar (ou ajuste `db.js`/`server.js`). O servidor também usa a pasta local de uploads (`UPLOAD_DIR` em `server.js`), com subpastas `fotos/`, `documentos/`, `projetos/`, `outros/`.

## API REST

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Interface web |
| GET | `/static/*` | Assets do frontend |
| GET | `/uploads/*` | Arquivos da pasta compartilhada |
| GET | `/api/messages?since=&limit=` | Histórico de mensagens (com anexos via JOIN) |
| GET | `/api/search?q=` | Busca FTS5 no histórico |
| GET | `/api/status` | Nós, tarefas, telemetria do sistema |
| GET | `/api/files` | Lista da pasta compartilhada (recursiva, com categoria/tamanho/data) |
| GET | `/api/download?file=` | Download de arquivo |
| GET | `/api/tasks?status=` | Lista de tarefas |
| POST | `/api/upload` | Upload de arquivo (multipart) → vira mensagem com anexo |
| POST | `/api/task` | Cria tarefa para um nó |
| WS | `/ws` | Canal de tempo real |

## Protocolo WebSocket

Eventos `{ type, ... }`:

- `auth` — `{ node, role }` ao conectar
- `message` — nova mensagem (inclui anexo quando houver)
- `system` — mensagem de sistema
- `presence` — atualização do roster
- `typing` — indicador de digitação
- `stream_start` / `stream_chunk` / `stream_end` — streaming de resposta do agente

## Banco de dados

- `messages` — id, node, role, content, type, stream_complete, created_at
- `attachments` — message_id, filename, original_name, mime_type, size_bytes, width, height, pages
- `nodes` — cadastro da equipe
- `tasks` — fila de tarefas
- FTS5: `messages_fts` (triggers de INSERT/DELETE mantêm o índice)

## Segurança

- **IPs mascarados no repositório** via filtro git (placeholders no commit, valores reais só em runtime)
- Proteção contra path traversal em `/uploads/` e `/api/download` (`path.join` + prefixo)
- Sanitização de HTML no frontend (`escapeHTML` antes de renderizar conteúdo)
- Dados sensíveis (banco, logs, `work/`, `node_modules/`) fora do versionamento (`.gitignore`)

## Troubleshooting

- **Chat vazio / tela em branco no navegador**: abra o DevTools (F12) e verifique o Console. Erro `Cannot read properties of null` no `app.js` quase sempre é um `document.querySelector` apontando para um elemento que não existe no DOM (ex.: bloco HTML colado fora do `</body>` que o parser ignora). Mantenha modais e overlays dentro do `<body>`.
- **Histórico não carrega**: `loadMessages()` tem retry de 3s e roda independente do WebSocket; confira a aba Network para o status de `/api/messages`.
- **Banco travado**: o SQLite roda em modo WAL — apenas um processo pode abrir o `nexus.db`. Use `lsof | grep nexus.db` para conferir.
- **Mensagens não aparecem após deploy**: a UI serve o frontend direto do disco (`public/`); após alterar `server.js`, reinicie o serviço; após alterar `public/`, apenas recarregue a página (Ctrl+Shift+R).

## Licença

Uso interno da equipe. Distribuição e uso sujeitos a autorização.

## Requisitos futuros (registrados — não implementar agora)

- **Contexto de projeto por tarefa**: toda tarefa deve possuir contexto de projeto e máquina-alvo, evitando trabalho paralelo/desconectado entre Linux e Windows.
- **Cadastro formal de dispositivos**: hoje os 4 dispositivos conhecidos (fabio, linux, windows, android) têm poder total; no futuro, cadastro/revogação por dispositivo (ex.: celular perdido revogado sem trocar o token dos demais).
- **Múltiplas identidades com permissões distintas** (ex.: identidade convidada com permissões reduzidas).
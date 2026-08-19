# NEXUS 2.0 — Stable Messaging + Attachments

Chat de equipe multi-dispositivo (Linux · Windows · Android) com agentes de IA, mensagens interativas e anexos profissionais. Marco **2.0.0**: fundação funcional — autenticação, recuperação, testes, mensagens interativas e cartões de anexo validados.

---

## Estado oficial (fotografia do projeto)

### ✅ Implementado e validado (com testes e evidências)

| Recurso | Detalhe |
|---|---|
| **Autenticação e sessões** | Token bootstrap → sessão HttpOnly (30d) → HTTP e WebSocket autenticados; identidade vem só da sessão (node/role enviados no payload são ignorados) |
| **FULL POWER dos dispositivos confiáveis** | fabio, linux, windows e android têm poder total (comandos, delegação, arquivos); dispositivo sem sessão = zero acesso (401) |
| **WebSocket autenticado** | Handshake rejeitado com 401 sem sessão; maxPayload 256KB; heartbeat 30s; reconexão progressiva (1s→2s→…→30s) |
| **Robustez de entrada** | NUL/C0 sanitizados na entrada (spawn nunca quebra); mensagem vazia → 400; >64KB → 413; body >1MB → 413 limpo; JSON inválido → 400; campos extras ignorados |
| **Path traversal** | `realpath` + prefixo (cobre `..`, percent-encoding, backslash, symlinks) — 403/404 em todos os ataques testados |
| **Backups + restore** | Diário às 04:00 (VACUUM INTO), retenção 7, restore testado em banco separado (produção nunca sobrescrita) |
| **Recuperação automática** | `systemd` `Restart=always` (3s), kill -9 → volta sozinho, banco íntegro, sem loop |
| **Mensagens interativas** | Clique na mensagem marca (`.selected`) + abre menu; menu com Responder / Mencionar / Copiar (nome·caminho·mensagem) / Selecionar; reply com `reply_to` + quote clicável; long-press mobile (threshold + suppress do click sintético) |
| **Menções como entidades** | `@linux` em QUALQUER posição do texto/legenda aciona o orquestrador; múltiplas menções = múltiplas tarefas; não confunde `email@linux.com` |
| **Anexos profissionais** | Cartão único por arquivo; **preview real** de imagem (lightbox) e **thumbnail da 1ª página de PDF** (pdftoppm); ícones com gradiente + **selo de extensão** grande (`.PDF`, `.JSON`, `.DB`…); metadados: tipo, tamanho, páginas, duração (ffprobe), dimensões (identify) |
| **Nomes limpos** | Pasta compartilhada sem prefixos de timestamp; uploads novos nascem com o nome original + dedupe ` (1)`; `original_name` (exibido) separado do `filename` físico |
| **Histórico e busca** | SQLite + FTS5, histórico persistente, 1 bloco DOM por mensagem, `data-message-id`/`data-message-content` em 100% |
| **Testes** | **33/33** (`npm test`), `node --check` limpo, regressões no navegador real |

### 🟡 Implementado, mas não totalmente validado

- **Long-press / touch no Android** — reescrito (threshold de movimento + click sintético suprimido), mas sem aparelho real para confirmar
- **Clipboard** — `navigator.clipboard` com fallback `execCommand`; feedback visual via toast; validação final depende do navegador com foco
- **PWA** — manifest + service worker registrados; controle ativo e comportamento offline ainda não confirmados em aparelho real
- **Lightbox, cartões e selos** — validados em desktop; confirmação visual final no Android pendente
- **MP3 real com duração** — o `ffprobe` preenche duração em áudios reais (testado só com arquivo fake)

### 🔭 Planejado (não iniciado)

- `@visao` (anexo → descrição multimodal com modelo TOP)
- DAG / execução paralela de agentes
- Cadastro/revogação formal de dispositivos; múltiplas identidades com permissões
- Contexto formal de projeto/máquina-alvo por tarefa
- MCP/skills configuráveis; runtimes (Hermes/Claude/Codex)
- Debate/votação entre agentes; browser/terminal/canvas no chat; encaminhar/excluir mensagens

---

## Arquitetura

```
NEXUS (Node.js) — HTTP + WS :3777
├── server.js       rotas, sessões, uploads, metadados de anexo
├── db.js           SQLite (messages, attachments, nodes, tasks + FTS5)
├── orchestrator.js fila serial, menções, delegação, política de limites
├── bridge.js       agentes: opencode local (Linux) e remoto (Windows via SSH)
└── public/         frontend vanilla (sem framework)
```

## Como rodar

```bash
npm install
cp .env.example .env   # preencha token e IPs
node server.js         # ou: systemctl --user start nexus
```

Serviço (persistente): `~/.config/systemd/user/nexus.service` (Restart=always) + backup diário (`nexus-backup.timer`).

## Segurança (resumo)

- Token único em `.env` (gitignored, permissão 600) → sessões HttpOnly SameSite=Lax
- Identidade inforjável (sessão é a única fonte), FULL POWER só para dispositivos autenticados
- Entrada sanitizada (NUL/C0), limites (body 1MB, mensagem 64KB, WS 256KB, upload 100MB)
- Path traversal bloqueado (realpath), `.thumbs` interno protegido
- IPs mascarados no repositório público (placeholders `LINUX_TAILSCALE_IP` etc.)

## Testes

```bash
npm test        # 33 testes (unit + integração com servidor real em porta de teste)
node --check $(git ls-files '*.js')
```

## Rotina

```bash
git status && git diff    # revisar antes de mexer
git add -A && git commit -m "descrição"
git push                  # backup no GitHub
```

Repositório público: https://github.com/rosestolatoti/opencode-chat
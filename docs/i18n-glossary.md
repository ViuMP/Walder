# Translation glossary

This is the term list and style sheet that Walder's six translations (Danish, Simplified Chinese,
Hindi, Spanish, French, German) are reviewed against. Localisation teams build one when there is
no native reviewer. It fixes one word for each recurring product term and one register per language.
The review then becomes a consistency check against a written standard, not a question of taste.

**The translations were written by a machine** and no native speaker has read them
([accessibility.md](accessibility.md#language)). They are reviewed against this glossary before a
release. After release, testers' and users' corrections
([issues](https://github.com/ViuMP/Walder/issues/new)) are checked against it. A correction a native
speaker gives wins over this file, and this file is then updated to match. The tables are in
[`src/core/i18n/`](../src/core/i18n/), one file per language. English (`en.ts`) is the reference.

Where possible the terms follow the operating-system vendors' own UI for that language: **Apple
macOS** for the menu bar, Settings and app menus, and **Microsoft Windows** for the notification
area. When the two disagree, the entry says which one we use. Entries marked *(unverified)* are
from memory and have not been checked against Apple's or Microsoft's published terminology. Before
changing a table to match one of them, look it up in [Microsoft Terminology
Search](https://learn.microsoft.com/en-us/globalization/reference/microsoft-terminology) or Apple's
localisation glossaries.

Terms and rules were checked against the tables as of 2026-11-19 (branch `fixes-0.3.2`).

## Rules for every language

**Never translated:**

- **Brand and product names:** Walder, Yuna, Claude, Claude Code, ChatGPT, Codex, Codex CLI,
  Cursor, Copilot, GitHub, GitHub CLI, Gemini, Antigravity, claude.ai, chatgpt.com. Grammar may
  attach to a name where the language needs it: Danish/German `Claude Code-hooks` and
  `Walders`, Hindi `Walder के`.
- **Placeholders** `{like_this}`: each one exactly as in English, same spelling, none added or
  dropped (`test/i18n.test.ts`). Move them anywhere the grammar needs.
- **Commands and file names:** `gh auth login`, `codex login`, `codex`, `claude`, `/hooks`,
  `npm run probe -- --keys`, `config.toml`, JSON. Keep any backticks the English has.
- **Key names:** Cmd, Ctrl, Alt, Shift, Up, Down, and accelerators like `Alt+Shift+W`. The
  arrow names in `window.cardLinesHelp` are an exception: they may follow the OS keyboard naming
  (German `Alt+Pfeil nach oben`, Spanish `Alt+Arriba`, …), as the tables do now.
- **Language endonyms** (`ENDONYMS` in `index.ts`), coat names, hook event names, `WALDER` in the
  card title, `…zzz`, `OK`.

**Structural rules:**

- **Menu paths:** a path written with `▸` must spell each step exactly like the menu item it
  names, minus the trailing `…`. Example: `bubble.introLogin` = `tray.accounts` ▸ Claude ▸
  `tray.logIn`, and `hooks.offerLater` = `tray.hooks` ▸ `tray.install*Hooks`. All six tables
  match today.
- **Width:** `bucket.*` labels must fit in 18 display columns, where a CJK character counts as two
  (`test/card-layout.test.ts`).
- **Data labels:** bucket labels, status messages and source labels are translated only where they
  are drawn (`display-text.ts`). The English stays the data, so changing a translation never
  breaks a match.
- **One word per concept** across the whole table, menu and window alike: the term tables below.
- **Size and mood adjectives agree with their noun.** The dog size (`tray.large/medium/small`) and
  the card size (`cardSize.*`) are separate keys for that reason: Danish *Stor/Stort*, Spanish
  *Grande·Mediano·Pequeño / Grande·Mediana·Pequeña*, French *Grand / Grande*. This is a rule, not an
  inconsistency.

**Typography, done by code — tables must not do it:** `typeset()` in `index.ts` runs over every
string.

- **Percent:** it puts the language's CLDR space (`PERCENT_SPACE`) between a digit or `}` and `%`.
  That is a no-break space U+00A0 for da, de, es and fr, and nothing for en, hi and zh-CN.
- **French punctuation:** it puts a no-break space before `:` and a narrow no-break space U+202F
  before `;`, `?` and `!`.
- **The rule for tables:** write `95%` and `{label}: …` with **no space at all** before `%`, `:`,
  `;`, `?` or `!`, and never type U+00A0 or U+202F. A typed ordinary space is replaced, so it does
  no harm. But it makes the source read differently from the screen, and in hi and zh-CN the
  source shows `95 %` where the screen shows `95%`.
- **Today:** no table contains a no-break space. These 11 lines have a typed space before `%`, to
  remove when the file is next touched: `de.ts:64` and `fr.ts:63` (`a11y.dogPct`), plus `es`, `hi`
  and `zh-CN` `tray.barkPreset.quiet`, `tray.barkPreset.chatty` and `help.barkPreset`. French types
  a space before `:` in about 40 strings and none in `bubble.nudge`. Both render the same, so going
  forward write none.

**Other typography, by hand:**

- **Ellipsis:** always the single character `…` (U+2026), never `...`. A menu item that opens a
  window or dialog ends in `…`, exactly where English has one. All tables comply.
- **Quotation marks:** from CLDR `delimiters` (`cldr-misc-full`, checked 2026-11-19):

  | Language | Quotes | Inner quotes |
  |---|---|---|
  | da | “…” | ‘…’ |
  | de | „…“ | ‚…‘ |
  | fr | «…» | «…» |
  | es | “…” | ‘…’ |
  | hi | “…” | ‘…’ |
  | zh-CN | “…” | ‘…’ |

  `typeset()` does not insert the space French puts inside « ». A French string that needs quotes
  must carry it itself, so French tables avoid quotes and name an option by its capitalised label
  (*Système suit…*), as they do now. Only zh-CN uses quotes today, correctly.
- **Apostrophe:** the typographic ’ (U+2019) in French (`l’os`, `d’accès`), as the table does.
  No other table needs one.
- **Dash:** every table copies English `X — Y` (spaced em dash) as a separator in status and
  login lines. This is acceptable as a UI separator; it is low priority and not a review blocker.
  Native style would be a spaced en dash ` – ` in da, de and fr, and `——` with no spaces in zh-CN.
- **Sentence ending:** Hindi ends sentences with `।` and Chinese with `。`; the others use `.`.
  Chinese uses full-width `：（），、；？！` next to Chinese text.

## Shared concepts with more than one meaning

Several English words cover two concepts, and each table must keep them apart:

| English | Sense A | Sense B |
|---|---|---|
| **token** | Usage tokens counted against a limit: `usage.tokens`, `bucket.tokensToday*` | A login credential: `status.claudeExpired` |
| **session** | A Claude Code or Codex working session on the card: `card.sessionsTitle`, `cardLines.sessions` | Being logged in. In English that is always *log in / login*, never *session* |
| **update / refresh** | A new Walder release: `update.*`, `bubble.update` | Fetching the numbers again: `tray.refreshNow`, `settings.pollInterval`, `usage.refreshed*` |
| **limit / cap / pool** | A usage limit window (*limit*) | A spend ceiling (*spend limit*, *no cap*), or the shared allowance (*shared pool*) |
| **reset** | When a usage window starts over: `reset.*`, `tray.resetTimes` | Putting something back to its default: `tray.resetPosition`. Two words are fine here |

## Danish (da)

**Register:** *du*, lower-case, as both Apple and Microsoft write Danish UI. Imperatives for actions
(*Klik*, *Installer*). The table complies (`Du har den nyeste version`, `Føl dig hjemme`). No *De*.

| English | Danish | Basis / note |
|---|---|---|
| menu bar | menulinje(n) | Apple |
| system tray / tray | systembakke(n) | Windows; `bubble.introHelloTray` uses it. ✓ |
| tray menu / bone menu | Walders menu | `hooks.offerLater` and `window.noUsageYet` say *menuen*. ✓ |
| settings | indstillinger | Apple and Windows. ✓ |
| quit | Afslut | Apple (“afsluttet” in Apple's da-dk support); Windows. ✓ |
| restart | Genstart | ✓ |
| log in / log out | Log ind / Log ud | Apple. Windows says *Log på / Log af*; we follow Apple. ✓ |
| login (noun) | login | ✓ (`Claude Code-login`) |
| account | konto, pl. konti | ✓ |
| usage | forbrug | ✓ (*brugt* for “used”) |
| limit | grænse | ✓ |
| spend limit / cap | forbrugsgrænse / loft | ✓ |
| reset (window) | nulstilling, *nulstilles om* | ✓ |
| session (agent) | session, pl. sessioner | ✓ |
| tokens (usage) | tokens | ✓ |
| token (login) | token(et) | ✓ |
| credits | kreditter, sg. kredit | ✓ |
| hooks | hooks | Lower-case in running text; `Hooks` as the menu title. ✓ |
| bone | knogle(n) | ✓ |
| hover card | infokort | ✓ |
| speech bubble | taleboble | ✓ |
| Small / Medium / Large | Lille / Mellem / Stor (dog), Stort (card) | Agreement. ✓ |
| hide | skjul | Apple. ✓ |
| notification | notifikation | Apple *Notifikationer*; Windows *Meddelelser* *(unverified)*. The menu item “Notify when hidden” is *Giv besked når skjult*. ✓ |
| report a bug | Rapporter en fejl… | ✓ |
| update (release) | opdatering; *Søg efter opdateringer* | ✓ |
| refresh | opdater | **Inconsistent:** `tray.refreshNow` *Tjek nu*, but *Opdateringsinterval* and *opdateret for … siden*. Make it *Opdater nu*. |
| waiting / done | venter / færdig | ✓ |
| idle / sleep | inaktiv / sov | ✓ |
| Light / Dark / Automatic | Lyst / Mørkt / Automatisk | Apple has *Lys / Mørk*; the neuter form agrees with *tema* and is fine. |
| language / System | Sprog / System | ✓ |
| desktop | skrivebord | Apple. ✓ |

## German (de)

**Register:** *Sie*, as Windows and macOS German UI address the user. Instructions and menu items
use the infinitive (*Claude Code-Hooks installieren*, *Terminal öffnen*), and full sentences use
*Sie / Ihr*. The table complies and has no *du*. Hyphenate brand compounds: *Claude Code-Hooks*,
*Codex-Guthaben*.

| English | German | Basis / note |
|---|---|---|
| menu bar | Menüleiste | Apple. ✓ |
| system tray / tray | Infobereich | Windows. ✓ |
| tray menu / bone menu | Walder-Menü | ✓ |
| settings | Einstellungen | Apple and Windows. ✓ |
| quit | Beenden | ✓ |
| restart | Neu starten (noun: Neustart) | ✓ |
| log in / log out | Anmelden / Abmelden | Apple and Windows. ✓ |
| login (noun) | Anmeldung | ✓ |
| account | Konto, pl. Konten | ✓ |
| usage | Nutzung (*genutzt*) | ✓ |
| limit | Limit, pl. Limits | ✓ |
| shared pool | gemeinsames Kontingent | ✓ |
| spend limit / cap | Ausgabenlimit / Obergrenze | ✓ |
| reset (window) | Reset | **Inconsistent:** *Zurücksetzzeiten*, *Zurücksetzung ausstehend* and `cardLines.reset` sit next to *Reset in 2 Std.*. Use *Reset* throughout (*Reset-Zeiten*, *Reset ausstehend*), because it is short enough for the card. Keep *Position zurücksetzen*. |
| session (agent) | Sitzung | ✓ |
| tokens (usage) / token (login) | Tokens / Token | ✓ |
| credits | Guthaben | ✓ |
| hooks | Hooks (der Hook) | ✓ |
| bone | Knochen | ✓ |
| hover card | Infokarte | ✓ |
| speech bubble | Sprechblase | ✓ |
| Small / Medium / Large | Klein / Mittel / Groß | ✓ |
| hide | ausblenden | Apple. ✓ |
| notification | Benachrichtigung | Windows; Apple says *Mitteilung*. We follow Windows, since a Mac user reads it without trouble. ✓ |
| report a bug | Fehler melden… | ✓ |
| update (release) | Update; *Nach Updates suchen* | ✓ |
| refresh | aktualisieren | **Inconsistent:** *Jetzt prüfen* and *Prüfintervall*, but *vor … aktualisiert*. Pick one verb; *aktualisieren* (Windows F5) is suggested. |
| waiting / done | wartet / fertig | ✓ |
| idle / sleep | Leerlauf / schlafen | ✓ |
| theme | Design | Windows; Apple's appearance setting is *Erscheinungsbild*. ✓ |
| Light / Dark / Automatic | Hell / Dunkel / Automatisch | Apple. ✓ |
| language / System | Sprache / System | ✓ |
| desktop | Schreibtisch | Apple; Windows says *Desktop*. ✓ |

## French (fr)

**Register:** *vous*, as both Apple and Microsoft write French UI. Infinitives for menu items
(*Installer les hooks…*) and *vous* imperatives in sentences (*Cliquez*, *mettez Walder à jour*).
The table complies. France French (`OWN_TAG` fr-FR); no Canadian forms.

| English | French | Basis / note |
|---|---|---|
| menu bar | barre des menus | Apple. ✓ |
| system tray / tray | zone de notification | Windows. ✓ |
| tray menu / bone menu | menu de Walder | ✓ |
| settings | réglages | Apple (*Réglages Système*); Windows says *Paramètres*. Used consistently, so we keep Apple's. |
| quit | Quitter | ✓ |
| restart | Redémarrer | ✓ |
| log in / log out | Se connecter / Se déconnecter | Apple and Windows. ✓ |
| login (noun) | connexion | ✓ |
| account | compte | ✓ |
| usage | utilisation (*utilisés*) | ✓ |
| limit | limite | ✓ |
| spend limit / cap | plafond de dépense / plafond | **Inverted:** `tray.accountState.extra-usage-limit-reached` says *Plafond … atteint (sans limite)* for “limit reached (no cap)”. Use *Limite de dépense … atteinte (sans plafond)*. |
| reset (window) | réinitialisation, *se réinitialise* | ✓ |
| session (agent) | session | ✓ |
| tokens (usage) / token (login) | jetons / jeton | One word for both, as Microsoft does. A native reviewer may prefer *tokens* for usage. |
| credits | crédits | ✓ |
| hooks | hooks (m.) | ✓ |
| bone | os | ✓ |
| hover card | carte de survol | ✓ |
| speech bubble | bulle | ✓ |
| Small / Medium / Large | Petit·Moyen·Grand (dog), Petite·Moyenne·Grande (card) | Agreement. ✓ |
| hide | masquer | Apple. ✓ |
| notification | notification | ✓ |
| report a bug | Signaler un bug… | Acceptable; *Signaler un problème…* is the more formal option. |
| update (release) | mise à jour; *Rechercher des mises à jour* | ✓ |
| refresh | actualiser | **Inconsistent:** *Vérifier maintenant* and *Intervalle de vérification*, but *actualisé il y a*. Pick one. |
| waiting / done | en attente / terminé | ✓ |
| idle / sleep | inactif / dormir | ✓ |
| Light / Dark / Automatic | Clair / Sombre / Automatique | Apple. ✓ |
| language / System | Langue / Système | ✓ |
| desktop | bureau | ✓ |

## Spanish (es)

**Register and variety:** *tú*, as both Apple and Microsoft write Spanish UI. Never *usted*, never
*vosotros*.

- **Variety:** Spain Spanish, because the code already formats Spanish as Spain does: `OWN_TAG`
  es-ES and the `87 %` percent space. Vocabulary is Spain's where the two differ (*vídeo*, *cuenta
  atrás*, *bocadillo*, *equipo*).
- **Past tense:** Spain uses the present perfect for something that has just happened. The table
  mostly uses the Latin American preterite. Change it: *ha terminado*, *ha cambiado*, *ha
  caducado*, *ha fallado*, *Ya ha salido Walder {version}*, *No se ha cambiado nada* (`bubble.hookDone`,
  `card.status.endpointChanged`, `status.claudeExpired`, `update.failed`, `lastCheck.failed*`,
  `bubble.update`, `hooks.failedDetail`, `hooks.summary.*`). Watch card width for `bubble.hookDone`.
- **Click:** a mouse click is *haz clic*, as Apple and Microsoft write it. *Pulsa* is for a key, as
  in `window.cardLinesHelp`. Change `bubble.introHello` and `bubble.introHelloTray` to *Haz clic en
  el hueso…*.

| English | Spanish | Basis / note |
|---|---|---|
| menu bar | barra de menús | Apple. ✓ |
| system tray / tray | área de notificación | Windows. **Differs:** `bubble.introHelloTray` says *la bandeja*; use *el área de notificación*. |
| tray menu / bone menu | menú de Walder | ✓ |
| settings | ajustes | Apple es-ES (*Ajustes del Sistema*); Windows says *Configuración*. Used consistently. ✓ |
| quit | Salir | ✓ |
| restart | Reiniciar | ✓ |
| log in / log out | Iniciar sesión / Cerrar sesión | Apple and Windows. ✓ |
| login (noun) | sesión (*sesión de Claude Code*) | ✓ |
| account | cuenta | ✓ |
| usage | uso (*usado*) | ✓ |
| limit | límite | ✓ |
| spend limit / cap | límite de gasto / tope | **Inconsistent:** `bucket.codexSpendLimit` *Tope Codex*, where English says “limit”. Use *Límite Codex*. |
| reset (window) | restablecimiento, *se restablece* | ✓ |
| session (agent) | sesión | Same word as login. The card heading *SESIONES* is clear in context; never use *sesión* for the agent elsewhere. |
| tokens (usage) / token (login) | tokens / token | ✓ |
| credits | créditos | ✓ |
| hooks | hooks (m.) | ✓ |
| bone | hueso | ✓ |
| hover card | tarjeta flotante | ✓ |
| speech bubble | bocadillo | ✓ |
| Small / Medium / Large | Pequeño·Mediano·Grande (dog), Pequeña·Mediana·Grande (card) | Agreement. ✓ |
| hide | ocultar | ✓ |
| notification | notificación | ✓ |
| report a bug | Informar de un error… | ✓ |
| update (release) | actualización; *Buscar actualizaciones* | ✓ |
| refresh | actualizar | **Inconsistent:** `tray.refreshNow` *Comprobar ahora*, but *Intervalo de actualización* and *actualizado hace*. Use *Actualizar ahora*. |
| waiting / done | esperando / terminado | ✓ |
| idle / sleep | en reposo / dormir | ✓ |
| Light / Dark / Automatic | Claro / Oscuro / Automático | Apple. ✓ |
| language / System | Idioma / Sistema | ✓ |
| desktop | escritorio | ✓ |
| *Make yourself at home.* | Estás en tu casa. | **Gendered:** `window.headline` *Ponte cómodo* assumes a man. |

## Hindi (hi)

**Register:** *आप* with the polite imperative in *-ें* (*क्लिक करें*, *इंस्टॉल करें*), as Microsoft
and Apple write Hindi UI. The table complies: no *तुम* and no *-ो* imperatives. The *-इए* form in
`window.headline` (*समझिए*) is also *आप* and fine for a greeting.

- **Vocabulary:** prefer the transliterated English terms the OS vendors use (*सेटिंग्स*, *अपडेट*,
  *लॉग इन*, *फ़ाइल*) over Sanskritised coinages. Use a Hindi word only where it is the everyday one
  (*खाते*, *भाषा*, *उपयोग*, *सीमा*).
- **Nukta:** keep it consistently (*ज़रूरी*, *फ़ुलस्क्रीन*, *इंतज़ार*, *ख़त्म*). `tray.accountState.codex-credits-out`
  has *खत्म* where the rest of the table has *ख़त्म*.
- **Digits:** Western, by code. Do not use Devanagari digits.

| English | Hindi | Basis / note |
|---|---|---|
| menu bar | मेनू बार | Apple and Microsoft spell it *मेनू* *(unverified)*. **Differs:** the table spells *मेन्यू* three times. |
| system tray / tray | ट्रे | Windows' own term is probably *सूचना क्षेत्र* *(unverified)*. *ट्रे* matches the English “tray” and is kept until a reviewer says otherwise. |
| tray menu / bone menu | ट्रे मेनू | Keeps “tray menu” in `hooks.offerLater` and `window.noUsageYet`, like English. ✓ |
| settings | सेटिंग्स | Microsoft. ✓ |
| quit | बंद करें | *(unverified)* against Apple's Hindi app menu. ✓ |
| restart | रीस्टार्ट करें | Windows has *पुनः प्रारंभ करें* *(unverified)*; transliteration kept. ✓ |
| log in / log out | लॉग इन करें / लॉग आउट | ✓ *साइन इन* only where English says “sign in” (Cursor). |
| login (noun) | लॉगिन | ✓ |
| account | खाता, pl. खाते | ✓ |
| usage | उपयोग | Noun. *इस्तेमाल* is fine for the verb “use” in sentences. ✓ |
| limit | सीमा | ✓ |
| spend limit / cap | खर्च सीमा / ऊपरी सीमा | ✓ |
| reset | रीसेट | ✓ |
| session (agent) | सत्र | ✓ |
| tokens (usage) / token (login) | टोकन | ✓ |
| credits | क्रेडिट | ✓ |
| hooks | हुक | Menu title too. ✓ |
| bone | हड्डी | ✓ |
| hover card | होवर कार्ड | ✓ |
| speech bubble | बोली का गुब्बारा | ✓ |
| Small / Medium / Large | छोटा / मध्यम / बड़ा | ✓ |
| hide | छिपाएँ | ✓ |
| notification | सूचना | ✓ |
| report a bug | बग की रिपोर्ट करें… | ✓ |
| update (release) | अपडेट; *अपडेट जाँचें* | ✓ |
| refresh | रीफ़्रेश | Consistent. ✓ |
| waiting / done | इंतज़ार में / पूरा | `serviceStatus.waiting` *इंतज़ार* drops *में*; acceptable as a status word. |
| idle / sleep | निष्क्रिय / सोना | **Differs:** `tray.hideWhenIdle` says *खाली होने पर* (“when empty”). Use *निष्क्रिय होने पर छिपाएँ*. |
| Light / Dark / Automatic | हल्की / गहरी / अपने-आप | Feminine, agreeing with *थीम*. ✓ |
| language / System | भाषा / सिस्टम | ✓ |

## Simplified Chinese (zh-CN)

**Register:** *你*, not *您*, as Apple and Microsoft write Simplified Chinese UI (Windows: *你的电脑遇到问题*).
The table complies and has no *您*. Short and neutral; *请* only before an instruction in a status
line, as the table does.

- **Punctuation:** full-width (`：（），、。“”`).
- **Spacing:** one ordinary space between Chinese and a Latin word or a number (*安装 Claude Code 钩子*,
  *5 小时*). Exceptions: inside a run of time units (*{hours}小时{minutes}分后重置*), and before `%`,
  where the code puts none.

| English | Chinese | Basis / note |
|---|---|---|
| menu bar | 菜单栏 | Apple. ✓ |
| system tray / tray | 托盘 | Windows' own term is *通知区域*. *托盘* (系统托盘) is the everyday word and matches the English “tray”; kept. |
| tray menu / bone menu | 托盘菜单 | Keeps “tray menu” like English. ✓ |
| settings | 设置 | Apple and Windows. ✓ |
| quit | 退出 | Apple. ✓ |
| restart | 重新启动 | Apple and Windows. **Inconsistent:** `window.restartNote` and `help.hookPort` say *重启*; use *重新启动*. |
| log in / log out | 登录 / 退出登录 | Apple; Windows says *注销*. We follow Apple. ✓ |
| account | 账户 | Apple and current standard spelling; Microsoft's older form is 帐户. ✓ |
| usage | 用量 | ✓ |
| limit | 限额 | ✓ |
| spend limit / cap | 上限 / 封顶 | ✓ |
| shared pool | 共享额度 | ✓ |
| reset | 重置 | ✓ |
| session (agent) | 会话 | ✓ |
| tokens (usage) | token | Latin, as Chinese AI products write it. ✓ |
| token (login) | 令牌 | ✓ |
| credits | 点数 | ✓ |
| hooks | 钩子 | Menu title too. ✓ |
| bone | 骨头 | ✓ |
| hover card | 悬停卡片 | ✓ |
| speech bubble | 对话气泡 | ✓ |
| Small / Medium / Large | 小 / 中 / 大 | ✓ |
| hide | 隐藏 | ✓ |
| notification | 通知 | ✓ |
| report a bug | 报告问题… | ✓ |
| update (release) | 更新; *检查更新* | ✓ |
| refresh | 刷新 | Consistent. ✓ |
| waiting / done | 等待中 / 已完成 | ✓ |
| idle / sleep | 空闲 / 睡觉 | ✓ |
| Light / Dark / Automatic | 浅色 / 深色 / 自动 | Apple. ✓ |
| language / System | 语言 / 跟随系统 | *跟随系统* (“follow system”) is the usual Chinese label for this choice. ✓ |

## Open points across tables

These are the inconsistencies found on 2026-11-19, collected so a review pass can work through
them. None blocks a release.

1. **Refresh:** da, de, fr and es translate “Refresh now” with “check” but the interval and the
   age footer with “refresh”. Pick one verb per language.
2. **German reset:** *Zurücksetz-* and *Reset* are mixed. Use *Reset*.
3. **Spanish:** *bandeja* should be *área de notificación*. *Pulsa* should be *Haz clic* for the
   mouse. Use present-perfect past tenses for Spain. *Tope Codex* should be *Límite Codex*. *Ponte
   cómodo* is gendered.
4. **French spend limit:** *plafond* and *limite* are inverted in
   `tray.accountState.extra-usage-limit-reached`.
5. **Hindi:** *मेन्यू* should be *मेनू*. *खाली होने पर* should be *निष्क्रिय होने पर*. One nukta is
   missing (*खत्म*).
6. **Chinese restart:** *重启* should be *重新启动*.
7. **Typed spaces before `%`:** 11 lines, listed under Typography. Remove them; output is unchanged.
8. **Tray menu naming:** English says “tray menu” in `hooks.offerLater` and `window.noUsageYet`.
   da, de, fr and es say “Walder's menu”; hi and zh-CN say “tray menu”. Both are acceptable. The
   bone menu's own entries do not depend on it.

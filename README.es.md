# TeamAI

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh-CN.md) · **Español**

> **Traducción desactualizada:** esta traducción aún no refleja los cambios recientes del README en inglés (las funciones y claves de configuración añadidas desde la actividad en curso). Para el comportamiento y la configuración, consulta el [README en inglés](README.md).

> **Pendiente de traducir:** los reintentos de capacidad de Codex y las opciones `codexCapacity*` se describen en el [README en inglés](README.md).

TeamAI es un relé local multicuenta para **Claude Code** y la CLI oficial de **Codex**. Mantiene un grupo de cuentas independiente para cada proveedor y reintenta la solicitud con otra cuenta cuando la suscripción seleccionada no está disponible o se quedó sin cuota.

![Panel de TeamAI](docs/dashboard.png)

<sub>El panel de arriba es una captura real hecha con <code>teamai capture --redact full</code>: cuota y actividad reales, sin direcciones de cuentas.</sub>

> TeamAI es un proyecto de código abierto independiente. No está afiliado a Anthropic, a OpenAI ni al servicio no relacionado de teamai.com.

## Requisitos

- Node.js 20 o superior
- macOS o Linux
- `claude` y/o `codex` instalados por separado
- Tus propias cuentas de suscripción Claude Pro/Max o ChatGPT Codex

## Instalación

```bash
git clone https://github.com/soulduse/team-ai.git
cd team-ai
./scripts/install.sh
```

`install.sh` instala las dependencias, compila, enlaza los comandos
`teamai`/`tai`/`tac`/`tax` y ofrece agregar el bloque de shell. Es idempotente:
vuelve a ejecutarlo para actualizar. Usa `--no-shell` para omitir el bloque de
shell, o `--dry-run` para ver qué haría sin aplicar cambios.

Para hacer lo mismo a mano:

```bash
npm install
npm run build          # obligatorio: dist/ no está versionado
npm link
```

¿Quieres automatizar esto desde un agente de IA? Consulta [AGENTS.md](AGENTS.md),
que expone los mismos pasos como comandos deterministas con verificación y
ramas de error.

## Inicio rápido

```bash
teamai login
tai
```

`login` pregunta si quieres agregar `[1] Claude` o `[2] Codex`. Repítelo para sumar más cuentas. `tai` es el comando corto de sesión y equivale a `teamai start`: levanta el relé local y abre el panel. Desde la TUI, pulsa `1` para lanzar Claude Code o `2` para lanzar Codex. Cuando el cliente termina, vuelves al panel.

Para iniciar una sesión directa con un proveedor, usa los lanzadores dedicados. Inician el relé de TeamAI automáticamente cuando hace falta y pasan todos los argumentos finales al cliente oficial:

```bash
tac                   # Claude Code a través del grupo de cuentas de TeamAI
tac --resume          # equivale a: teamai claude --resume
tax                   # Codex a través del grupo de cuentas de TeamAI
tax resume            # equivale a: teamai codex resume
teamai claude         # forma larga de tac
teamai codex          # forma larga de tax
teamai session        # elige [1] Claude o [2] Codex de forma interactiva
```

Los nombres evitan deliberadamente reemplazar una función de shell `tc` existente de TeamClaude. `tc` puede seguir apuntando a TeamClaude mientras `tac` y `tax` apuntan a TeamAI.

## Configuración del shell

```bash
./scripts/install-shell.sh            # agrega un bloque delimitado a ~/.zshrc
./scripts/install-shell.sh --dry-run  # muestra el diff, no escribe nada
./scripts/install-shell.sh --uninstall
```

Define `cl` (Claude Code) y `co` (Codex) a través del grupo, además de `tai`,
`tais` y `taistart`/`tairestart`/`taistop` para el LaunchAgent, y desactiva
cualquier `ANTHROPIC_BASE_URL` fijada globalmente: TeamAI apunta cada sesión a
su propio puerto, así que un valor global obsoleto solo enruta el tráfico hacia
un proxy que quizá ya no esté en ejecución. El bloque está delimitado por
marcadores y se reescribe en su lugar, de modo que volver a ejecutarlo actualiza
en vez de acumular; cada escritura deja una copia de seguridad con marca de
tiempo, y los ciclos de instalación/desinstalación restauran el archivo byte a
byte.

El supervisor es opcional: `cl`, `co`, `tai` y `teamai run` levantan el relé por
su cuenta cuando no hay nada escuchando, así que siguen funcionando aunque el
LaunchAgent esté descargado, falle o nunca se haya instalado. Un `server.json`
obsoleto dejado por un proceso terminado se ignora y se reemplaza. Cuando el
arranque sí falla, se informa el motivo que devuelve el servidor (un puerto ya
en uso, un archivo de credenciales ilegible) en lugar de un escueto "did not
start", y la salida completa queda en
`~/.config/teamai/server-start.log`.

### Ejecutar el relé como elemento de inicio de sesión

Esto es opcional. Los alias `taistart`/`tairestart`/`taistop` instalados arriba
controlan un LaunchAgent con la etiqueta `com.teamai.proxy`, así que usa
exactamente esa etiqueta:

```xml
<!-- ~/Library/LaunchAgents/com.teamai.proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.teamai.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/team-ai/dist/src/cli.js</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardErrorPath</key> <string>/tmp/teamai.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.teamai.proxy.plist
```

Usa `command -v node` para obtener la ruta real de Node; un LaunchAgent no
hereda el PATH de tu shell.

## Cuentas

Codex usa su flujo habitual de inicio de sesión por navegador. TeamAI no requiere que esté habilitada la opción de autenticación por código de dispositivo de ChatGPT.

Importar credenciales es opcional y solo funciona cuando existe un archivo de credenciales exportable:

```bash
# Importa todas las cuentas desde una configuración existente de TeamClaude.
teamai import claude --from ~/.config/teamclaude.json

# Importa el inicio de sesión actual basado en archivos de la CLI de Codex, si existe.
teamai import codex
```

Las versiones recientes de Claude Code pueden guardar las credenciales en el Llavero de macOS en lugar de en `~/.claude/.credentials.json`; en ese caso usa `teamai login`. `import` nunca modifica los archivos originales de TeamClaude, Claude Code ni Codex. TeamAI usa un directorio de Codex aislado y persistente para las sesiones que pasan por el relé, de modo que el `~/.codex` original del usuario queda intacto.

## Operación

```bash
teamai status                                  # estado del servidor + tabla de cuentas
teamai accounts [claude|codex]                 # solo la tabla de cuentas
teamai start                                   # inicia el relé y abre el panel
teamai stop                                    # detiene el relé
teamai restart                                 # detiene, inicia y abre el panel
teamai server                                  # ejecuta el relé en primer plano
teamai tui                                     # solo el panel, sin inicio automático
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1      # o bien: auto
teamai capture [--redact partial|full|none] [--out DIR]   # guarda el panel como .txt y .png (sin TTY)
teamai route list                              # rutas por modelo, en el orden en que se prueban
teamai route add luna --provider codex --match 'gpt-6-luna*' --accounts a@x.com,b@y.com --mode prefer --color blue
teamai route rm luna
```

Las cuentas con la misma prioridad se ordenan por **ritmo semanal**, tanto en el
panel como en la selección del propio pool, así que la fila superior es la
cuenta a la que iría la siguiente solicitud. Cada presupuesto semanal se lee
como una recta que va del 0 % al empezar la semana al 100 % en su reinicio, y
la desviación de una cuenta es su uso semanal menos la fracción de semana ya
transcurrida: una cuenta *por detrás* de su recta (negativa) tiene presupuesto
que perderá en el reinicio si no lo gasta, así que va primero. Es un orden, no
un bloqueo: si todas van por delante, se usa la que menos. Una cuenta a punto de
reiniciarse con presupuesto sobrante ya es la más retrasada, por lo que no hay
una regla aparte de "reinicio próximo". La ventana semanal es la que gasta la
solicitud: `7d` en Claude (su ventana semanal Fable para una solicitud Fable) y,
en Codex, la ventana de 10080 minutos, se llame como se llame. Desviaciones a
menos de 5 puntos cuentan como empate, para que dos cuentas no se alternen en
cada solicitud; un empate lo gana la cuenta en la que ya está la sesión, luego
la que más presupuesto semanal tiene por semana restante, luego el reinicio
semanal más temprano y luego la ventana de 5 horas que se reinicia antes y está
menos usada. Una cuenta sin ventana semanal que se reinicie en el futuro (sin
medir, o con el reinicio ya pasado) va detrás de las que la tienen. La
prioridad explícita, el umbral de cambio (que también aparta una
cuenta cuya ventana de 5 horas lo alcanza, por atrasada que vaya su semana), el
anclaje de sesión y el límite de concurrencia se aplican antes, como siempre.
Cada fila muestra su desviación como `+12%p` / `-30%p`. `routing.balance:
"level"` recupera el orden anterior (la más llena de las ventanas de 5 horas y
semanal, en pasos del 10 %, con menos solicitudes en curso primero), y `c`
vuelve al orden configurado.

**Fable y los demás modelos.** Solo el modelo superior (el nivel Fable de
Claude) consume la ventana semanal por modelo. El pool no aparta cuentas para
él: dentro de una ruta, toda solicitud —Fable o no— sigue la prioridad (primero
los valores explícitos, el número menor primero) y luego el equilibrio descrito
arriba, que para una solicitud no Fable lee la ventana semanal compartida y para
una Fable la ventana Fable. Lo único que una solicitud Fable salta es una cuenta
que no puede atenderla: la que tiene la ventana Fable agotada (100 %) y la cuenta
medida que no informa ninguna ventana Fable (un plan sin Fable, como Pro); una
cuenta aún sin medir se intenta. Esas cuentas siguen atendiendo los demás
modelos. Para apartar el tráfico de Opus o Sonnet de las cuentas que quieres
guardar para Fable, usa una ruta de modelo. La antigua clave
`fableReserveThreshold` ya no se lee; un `config.json` que aún la tenga arranca
igual.

Un 429 de nivel Fable (`7d_oi` rechazada mientras las ventanas compartidas
`5h`/`7d` siguen permitidas) solo limita la ventana Fable de esa cuenta, no la
cuenta: todos los demás modelos se siguen atendiendo desde ella, en vez de que
la cuenta entera quede inactiva hasta una semana por un presupuesto que solo
consume el modelo superior. Un 429 que rechaza una ventana compartida limita la
cuenta como de costumbre.

La TUI a pantalla completa agrupa las cuentas de Claude y de Codex, y mantiene anclada la cuenta seleccionada aunque cambie el uso. Las filas de Claude muestran de forma independiente las ventanas `5h session`, `7d` y la ventana por modelo `7d Fable`; las filas de Codex muestran sus ventanas, cada una titulada con el periodo que esa cuenta realmente reporta (`5h`, `7d`). En todo el panel una semana se escribe `7d`, también en los recuadros de otros agentes y en el diseño estrecho. Todos los recuadros —los de cuentas y los de otros agentes debajo— dibujan sus barras en las mismas tres columnas y con el mismo ancho: primero la ventana de sesión (5h), después la semanal y en tercer lugar lo que el proveedor tenga además (`7d Fable` de Claude, `30d` de OpenCode Go). Cada ventana va a la columna que indica su duración, así que una cuenta de Codex o Grok con solo ventana semanal deja vacía la primera columna en lugar de desplazar la barra semanal a la izquierda. La columna anterior a las barras (account, plan, state y order, o el nombre del grupo) tiene el mismo ancho en todos los recuadros, y los campos tras las barras —la antigüedad de la medición, la desviación de ritmo (`+12%p`) y después `~D-N` en filas de Claude o `RC<n>` en filas de Codex— empiezan cada uno en una misma columna en todos los recuadros; en una terminal estrecha todos los recuadros se estrechan igual. Las cuotas se aprenden de las respuestas del cliente oficial y se conservan entre reinicios.

**Terminales estrechas.** El panel se dibuja al tamaño real de la terminal y se redibuja en cuanto ese tamaño cambia (el primer cuadro tras un cambio de tamaño borra antes la pantalla, así que no quedan restos del anterior), algo que importa cuando un teléfono y un escritorio se turnan para mirar la misma terminal. Por debajo de 80 columnas —o donde los recuadros anchos no caben con sus tres barras (78 columnas más una por marcador de ruta)— pasa a un resumen: una línea por cuenta y por grupo de uso de otros agentes, con un nombre corto (cortado con `…`), el cursor `>` y la marca `►` de la cuenta siguiente, las cifras de sesión y semana como `5h 62%  7d 84%` (la semana Fable de Claude y otras terceras ventanas como `30d` si hay sitio) y cuánto falta para que se reinicie la más gastada de ellas. Con espacio de sobra las cifras van en barras cortas; si no, solo porcentajes del mismo color que las barras. El nombre de una cuenta desactivada va en gris, con error en rojo y en enfriamiento en amarillo. Plan, estado, orden, antigüedad de la medición y ritmo quedan para el diseño ancho. La actividad pasa a una línea por petición —hora, sesión, `C`/`X`, estado (o segundos transcurridos mientras sigue en curso) y la cuenta—, cortada en el borde y nunca partida en dos, y ocupa las filas que quedan. El pie muestra las teclas que caben y `? help`; `?` lista todas las teclas en cualquiera de los dos diseños. Si además falta altura, las líneas ceden en un orden fijo —el resto del registro de actividad, los otros agentes, la cabecera, las cuentas que no son la actual ni la seleccionada—, de modo que la cuenta actual de cada proveedor y sus cifras siguen en pantalla. Ninguna línea es más ancha que la terminal, contando los caracteres anchos como dos columnas. Todas las teclas funcionan como antes.

**Carga del equipo.** La cabecera muestra el uso de CPU y RAM de este PC, medido por el propio panel con el módulo `os` de Node (sin API de servidor ni dependencias nuevas) y actualizado en cada redibujado: `CPU 12% · RAM 46% 7.3/16.0GB`. El CPU% es la fracción ocupada desde el redibujado anterior, así que el primer cuadro muestra `CPU –`; una cifra se pone amarilla desde el 70% y roja desde el 90%. La cantidad usada/total aparece solo en el diseño ancho. Junto al título, la cabecera solo muestra esto y, en el diseño ancho, la dirección y los puertos del relay; si le falta sitio, primero desaparece la cantidad y luego CPU/RAM entero, antes que los puertos. `teamai status` imprime las mismas cifras en una línea `Host:` y una captura también las incluye.

El pie de página ofrece el mismo flujo de trabajo de cuentas que TeamClaude: lanzar Claude/Codex, seleccionar, cambiar, habilitar/deshabilitar, ordenar, eliminar, agregar/iniciar sesión, volver a medir (`R`) y salir. `switch` fija la cuenta seleccionada al frente del grupo de su proveedor; el modo de orden permite asignar un puesto o devolver una cuenta a la programación automática. Al actualizar el perfil de Claude se muestra el nivel del plan y, en rojo, los estados de suscripción problemáticos como `past_due`.

**Los cambios de cuentas se aplican sin reiniciar.** Cada cambio, habilitar/deshabilitar, cambio de prioridad, inicio de sesión y borrado en el panel se guarda en `config.json` y luego se envía al servidor en ejecución por el puerto de control (`POST /reload`, solo loopback, el mismo token de cliente), que vuelve a leer en el sitio las cuentas, las rutas de modelo y `routing.balance`. No se corta nada en curso: una solicitud conserva hasta el final la cuenta con la que empezó — incluso una que se acaba de deshabilitar o borrar; una cuenta borrada termina las solicitudes que está atendiendo, no acepta ninguna nueva y sale del pool cuando acaba la última — y la siguiente solicitud se elige con la nueva configuración. El estado aprendido (uso, ventanas, enfriamientos, créditos de reinicio, las lecturas de otros agentes) se queda como estaba. El archivo se comprueba entero antes de cambiar nada — cada cuenta, las rutas de cada proveedor, el ajuste de balance — y un archivo que el servidor no puede usar se rechaza con el motivo en el panel mientras el servidor mantiene la configuración que tenía. `proxy`, `switchThreshold` y `maxConcurrentPerAccount` no se pueden cambiar en un proceso en marcha: si cambiaron, la recarga lo indica y se aplican en el siguiente `teamai restart`. El panel solo arranca un servidor cuando no hay ninguno en ejecución. `teamai login`, `import`, `enable`, `disable` y `priority` recargan del mismo modo un servidor en ejecución (y dejan parado uno parado). Tras actualizar TeamAI, ejecute `teamai restart` una vez: un servidor arrancado con la versión anterior no tiene la ruta de recarga, y el panel lo indica.

**Rutas por modelo.** `routes.claude` / `routes.codex` envían las peticiones de ciertos modelos a ciertas cuentas (se aplica la primera ruta que coincide). En el panel, `g` abre las rutas del proveedor de la fila seleccionada: listar, añadir (`a`), editar (`e`), borrar (`d`, se confirma con `y`) y reordenar (`[` `]`); `Tab` cambia entre Claude y Codex y `Esc` sale sin guardar. Antes de guardar, la ruta se valida con el mismo analizador que usa el servidor al arrancar; si falla, no se escribe nada y el motivo queda en pantalla. Guardar reescribe de forma atómica solo `routes` en `config.json` y pide al servidor en marcha que relea las rutas por el puerto de control, sin reiniciar. `teamai route list|add|rm` sigue el mismo camino. El significado de cada campo (`match`, `accounts`, `prefer` / `exclusive`, `color`) está en las secciones Model routes / Editing routes del README en inglés.

Antes de escribir, el panel compara la lista de rutas que abrió con el archivo actual; si la CLI u otro editor la cambió, rechaza el guardado y pide volver a cargar en vez de sobrescribirlo. Una ruta `exclusive` debe incluir al menos una cuenta configurada para ese proveedor. El reload de control solo acepta loopback y analiza todos los proveedores antes de intercambiar los pools, así que un proveedor inválido deja intactas todas las rutas activas.

`p` guarda una captura del panel, y `teamai capture` hace lo mismo desde un script o un agente sin necesidad de terminal. Cada captura es un par de archivos bajo `~/.config/teamai/captures/` (o `--out DIR`): el cuadro como texto con sus colores intactos, y el mismo cuadro como PNG dibujado con una fuente de mapa de bits integrada, así que no hace falta nada más que Node. Las direcciones de las cuentas se enmascaran antes de dibujar el cuadro —en la columna de cuentas, en el pie y en el registro de actividad por igual— como `de•••••••••w@gm•••.com` de forma predeterminada; `--redact full` las reemplaza por `account #N`, y `--redact none` las conserva para una captura que se quede en privado. Desde el panel, `p` además muestra el PNG en el administrador de archivos y copia la imagen al portapapeles —en macOS sin configurar nada, en Linux si están instalados `xdg-open` y `wl-copy` o `xclip`— y el pie indica cuáles de esas acciones ocurrieron. La imagen al comienzo de este README es una de esas capturas. Una captura tiene el ancho de la terminal desde la que se toma (40 columnas como mínimo, 120 sin terminal), así que una tomada desde un teléfono muestra el diseño estrecho.

Las cuentas habilitadas también actualizan su cuota en segundo plano cada cinco minutos (más hasta 30 segundos de jitter por cuenta, un máximo de dos lecturas simultáneas y backoff exponencial de 30 segundos a 15 minutos en caso de fallo) desde el endpoint de uso sin coste de cuota de cada proveedor (`/api/oauth/usage` para Claude, `/wham/usage` para Codex), renovando primero los tokens próximos a vencer y omitiendo las cuentas deshabilitadas (`disabled`); `POST /reload` actualiza al instante las cuentas objetivo. `R` vuelve a medir la cuota de toda la flota de inmediato: primero lee el endpoint de uso y, solo para las cuentas que no pudieron leerse allí, reproduce en paralelo una forma de solicitud que ya se sabe aceptada contra cada cuenta inactiva (incluidas las ya medidas y las limitadas, cuyos 429 igualmente traen encabezados autoritativos) e informa un recuento honesto de `measured/targets`. Esa forma de solicitud solo se fija a partir de un 2xx real que haya pasado por el proxy, de modo que hasta que una solicitud no haya tenido éxito, `R` informa que todavía no existe una plantilla de sondeo en lugar de adivinar una carga útil. Las cuentas a las que les falta la ventana semanal por modelo (Fable) reciben un sondeo complementario adicional, porque esa ventana solo aparece en las respuestas a solicitudes de nivel Fable.

El keep-warm de Codex es impulsado por eventos. Diez segundos después de reiniciarse una ventana de 5 horas medida, TeamAI vuelve a leer el usage de esa cuenta y, solo si la lectura nueva confirma que la ventana anunciada está vacía (`0%`), ejecuta una vez el `codex exec` real con el modelo más pequeño y el prompt `hi` mediante la ruta local fija `/tc-acct/<account>/codex`. Las cuentas se procesan de una en una; un fallo se registra y se reintenta una vez tras diez minutos, y luego se espera al siguiente evento de usage o de ventana. Se usa la hora en que se envió la lectura, así que una respuesta retrasada anterior al warm no provoca otro warm. Seis minutos después de un warm (pasado el margen de cinco minutos que distingue una ventana vacía de una recién abierta) se vuelve a leer el usage: si la ventana sigue vacía, cuenta como fallo, de modo que un warm que nunca abre la ventana se envía dos veces y no cada diez minutos. Una ventana abierta no se vuelve a calentar hasta que se reinicia, aunque siga marcando `0%`. Una ruta fija que no nombra ninguna cuenta configurada se rechaza con 404 en lugar de servirse con otra cuenta. Cada cambio en la decisión del warmer y cada resultado de warm se escribe como una línea, solo con el número de cuenta, en la salida del servidor: `$TEAMAI_HOME/server-start.log` cuando el relay se inició bajo demanda.

Las cuentas inactivas se mantienen vivas mediante un barrido separado de cinco minutos: cualquier cuenta cuyo token esté por vencer o cuyo último intento haya dado error se refresca, de a una por vez. El tráfico normal se concentra en unas pocas cuentas y el calentamiento a propósito nunca refresca, así que sin esto una cuenta que nadie usa podría dejar caducar su cadena de refresh-token y que el upstream la invalide. El barrido es secuencial a propósito: refrescar toda la flota de golpe tras una caída prolongada dispararía el endpoint de tokens contra un límite de tasa.

La cuota aprendida (uso, ventanas, tiempos de reinicio, perfil de suscripción) se escribe en disco y se restaura en el siguiente arranque, de modo que el panel y el orden sobreviven a un reinicio sin volver a medir; la forma de sondeo que reproduce `R` se persiste igual. Las señales por respuesta no: un enfriamiento o un error se descartan a propósito al reiniciar, así una cuenta nunca vuelve a quedar limitada por el retry-after de un 429 obsoleto; si de verdad está agotada, la siguiente solicitud vuelve a deducir el estado correcto.

Si llegan a la vez más solicitudes de las que puede atender la concurrencia combinada por cuenta de la flota, el relé rechaza el excedente con `429` (`x-teamai-429-reason: concurrency_saturated`) antes de leer el cuerpo de la solicitud, en lugar de almacenar cuerpos sin límite. Ese mismo encabezado distingue una flota ocupada de una agotada (`quota_exhausted`) en el 429 de "no hay cuenta disponible".

El valor de suscripción `~D-N` es una estimación, no una fecha de vencimiento autoritativa: el endpoint de perfil de Anthropic expone el estado de la suscripción y la fecha de creación, pero no el fin del periodo de facturación actual. Por eso TeamAI estima el siguiente aniversario mensual de facturación y lo marca con `~`. El estado del perfil se actualiza al arrancar el servidor y cada seis horas.

## Configuración

La configuración y las credenciales viven en `$TEAMAI_HOME`, con respaldo en
`$XDG_CONFIG_HOME/teamai` y luego en `~/.config/teamai`. Los proxies se enlazan
a `127.0.0.1` y exigen un token de cliente local generado.

`config.json` se crea en la primera ejecución con estos valores por defecto:

| Clave | Valor por defecto | Significado |
| --- | --- | --- |
| `proxy.host` | `127.0.0.1` | Dirección de enlace. Solo loopback, por diseño. |
| `proxy.claudePort` | `3456` | Puerto del relé de Claude. |
| `proxy.codexPort` | `3457` | Puerto del relé de Codex. |
| `proxy.controlPort` | `3556` | Canal de control con el que habla la TUI. |
| `proxy.clientToken` | generado | Token local que debe enviar todo cliente que pase por el relé. |
| `switchThreshold` | `0.98` | Proporción de uso por encima de la cual una cuenta deja de seleccionarse. |
| `warmup.enabled` | `true` | Keep-warm de Codex impulsado por eventos; `false` lo desactiva. |
| `maxConcurrentPerAccount` | `16` | Solicitudes en curso permitidas por cuenta. `0` significa sin límite. |
| `routing.balance` | `"pacing"` | Cómo se ordenan las cuentas de igual prioridad: `pacing` (ritmo semanal, ver arriba) o `level` (ventanas menos llenas, en pasos del 10 %). |
| `routes` | — | Opcional. Rutas por modelo y proveedor, `{ "claude": [...], "codex": [...] }`; se editan con `g` en el panel o con `teamai route`. |
| `proxy.legacyPorts` | — | Opcional. Puertos adicionales en los que seguir respondiendo, por proveedor — p. ej. `{ "claude": [3400] }`. |
| `proxy.maxBodyMb` | `512` | Opcional. Tamaño máximo del cuerpo de una petición que acepta el relé, en MB. Un número mayor que `0` y como mucho `4096`; otro valor detiene el arranque con el motivo. Un cuerpo mayor no se envía: el relé responde `413` y registra solo el tamaño y el límite. El `413` del propio upstream llega al cliente sin cambios. |
| `proxy.maxInflightBodyMb` | `1024` | Opcional. Lo que pueden sumar, en MB, todos los cuerpos de petición retenidos en memoria a la vez (ambos proveedores). Sin definir, nunca menor que `proxy.maxBodyMb`; por debajo de él, o si no es un número mayor que `0` y como mucho `65536`, detiene el arranque con el motivo. Al superarlo la petición recibe `429` (`x-teamai-429-reason: body_budget`). |
| `proxy.bodyTimeoutMs` | `300000` | Opcional. Cuánto puede tardar en llegar el cuerpo de una petición, en ms; `0` sin límite. Pasado ese tiempo responde `408` (`x-teamai-408-reason: body_timeout`) y devuelve su parte de `proxy.maxInflightBodyMb`. Un entero de `0` a `86400000`; otro valor detiene el arranque con el motivo. |

Cambia un puerto si otro proceso ya lo ocupa: esa es la causa habitual de un
arranque fallido, y el motivo aparece en `server-start.log`.

Al cliente se le entrega su URL base al arrancar y ya no se puede redirigir
después, así que mover un puerto en `config.json` dejaría, de otro modo, sin
conexión a toda sesión ya abierta con «connection refused». Por eso el relé
también responde en el puerto por defecto integrado y en cualquier
`proxy.legacyPorts` que indiques, manteniendo vivas las sesiones abiertas al
cambiar de puerto. Un puerto heredado que ya esté ocupado por otro proceso se
omite sin afectar al puerto principal, y un error de socket posterior al
arranque se registra en lugar de dejar que tumbe el relé.

## Alcance y cumplimiento

La versión 0.1 apunta a cuentas OAuth de suscripción y a sesiones de CLI lanzadas mediante un wrapper. No expone una API pública compatible con OpenAI, no convierte solicitudes de Claude en solicitudes de Codex, no da soporte a Codex Desktop ni agrupa credenciales de personas distintas. La responsabilidad de cumplir los términos y las políticas de los proveedores es tuya. Las cargas de trabajo de API en producción o con fines comerciales deberían usar los mecanismos oficiales de facturación de API de los proveedores.

## Desarrollo

```bash
npm run typecheck
npm test
npm run lint
```

Consulta [NOTICE](NOTICE) para lo relativo a obra derivada y [SECURITY.md](SECURITY.md) para el modelo de seguridad local.

> Translation update pending: see the canonical English README for nested Codex relay configuration inheritance.

<!-- transient-recovery-2026-09-22 -->
Los errores transitorios conservan el estado HTTP, el cuerpo y Retry-After originales. Tras cambiar de cuenta, el relay permite hasta dos rondas de reintento, con un máximo de 10 segundos de espera por ronda y 20 en total. Las esperas mayores se devuelven al cliente; los streams exitosos no se repiten. Los reintentos HTTP de Codex siguen desactivados para evitar duplicarlos. Reinicia el relay después de compilar para aplicar los cambios.

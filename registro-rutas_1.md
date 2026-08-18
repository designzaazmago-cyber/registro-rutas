# Registro de Rutas — Documentación de la app

Este documento describe **cómo funciona hoy** `registro-rutas_1.html` (todo el código vive en ese único
archivo: HTML + CSS + JS). Está pensado para contrastarlo contra el flujo real de un instalador de campo
(caso "Jose") antes de tocar código.

> **Actualización:** la sección 4 (el desajuste "retorno a oficina vs. agregar punto") ya se implementó.
> Queda descrita tal cual estaba para que se entienda el problema, con una nota de "Estado" al final
> explicando cómo quedó resuelto. También se agregó la sección 6, con el panel de administrador nuevo.

---

## 1. Qué es

PWA (Progressive Web App) de una sola página, sin build ni backend propio:

- **Mapa**: Leaflet + teselas CARTO Voyager (gratis, sin API key).
- **Geocodificación / direcciones**: Nominatim (OpenStreetMap).
- **Cálculo de ruta y kilómetros**: OSRM público (`router.project-osrm.org`).
- **Persistencia local**: `localStorage` (namespace `rr.*`).
- **Persistencia remota**: un Google Apps Script (Web App `/exec`) al que se le hace `POST` de cada tramo
  cerrado — funciona como "base de datos" en una Google Sheet.
- **Offline / alarma con la app cerrada**: Service Worker (`sw.js`) + Notification API con `showTrigger`
  cuando el navegador lo soporta (alarma real programada), con fallback a revisión periódica.
- Un solo usuario/dispositivo por instalación — no hay login ni multiusuario.

---

## 2. Modelo de datos

Todo vive en memoria (variables globales) y se espeja a `localStorage` con `guardarTodo()`.

### `rutas` (historial — tramos ya cerrados)
Array de filas, una por cada tramo **registrado con llegada confirmada**:

```js
{
  id, fecha, hsal, hret,          // hora salida / hora llegada (HH:MM)
  origen, destino,                 // texto legible ("Calle Real, San Carlos, Huancayo")
  motivo, entidad,                 // motivo de la salida + empresa/cliente visitado
  km,                               // km de ESE tramo (no acumulado)
  metodo,                          // "Automático (OpenStreetMap)" | "Odómetro" | "Manual"
  notas, nube,                     // nota libre del viaje; nube=true si ya se confirmó envío a Sheets
  acum, ev                         // km acumulados a la fecha; eventos disparados ('f' combustible, 'm' mantenimiento)
}
```

### `viaje` (viaje en curso — null si no hay ninguno)

```js
{
  fecha, origen,                  // fecha del viaje, texto del origen
  tramos: [ {origen, destino, km, min, motivo, entidad, retorno?} ],  // TODA la ruta planificada, en orden
  idx,                             // índice del tramo que se está recorriendo ahora mismo
  esperando,                       // true = ya llegó al tramo idx y espera confirmar que SALE al siguiente
  hsal, t0,                        // hora y timestamp de la salida del tramo actual
  eta,                             // hora estimada de llegada del tramo actual (dispara la alarma)
  metodo, notas, avisado
}
```

**Un solo viaje activo a la vez.** Mientras `viaje` no es `null`, la tarjeta para planear uno nuevo
(`#cardNueva`, con el mapa, origen/destinos, etc.) se oculta (`pintarViaje()`); solo se ve la tarjeta
"Viaje en curso".

### Otros
- `entidades`: lista de empresas/clientes ya escritos (autocompletado del campo "Empresa / entidad / cliente").
- `favUser` + `FAV_BASE`: rutas frecuentes (origen→destino) para reusar con un toque.
- `cola`: filas pendientes de enviar a Google Sheets (si no hay internet, se reintenta luego).
- `coordsCache`: caché lat/lon por texto de dirección, para no volver a geocodificar.

---

## 3. Flujo actual, paso a paso

### 3.1 Planificar el viaje (antes de salir)

1. **Origen**: por defecto vacío ("Toca para elegir"); se puede fijar a mano (buscador + mapa a pantalla
   completa) o dejar que el GPS lo autocomplete si el usuario dio permiso de ubicación
   (`pedirUbicacion()` / `#origenGPS`, se ve en la tarjeta "Activa tu ubicación").
2. **Destino 1** (obligatorio): dirección + **Motivo de la salida** (lista fija: Reunión, Entrega de
   material, Recojo de material, Visita a cliente, Cobranza, Trámite, Instalación / soporte, Compra,
   Grabación / fotos, Otro) + **Empresa / entidad / cliente** (texto libre con autocompletado).
3. **"+ Agregar destino"**: agrega Destino 2, 3… **antes de salir** — cada uno con su propio motivo y
   entidad. Esto arma una ruta multi-parada ya planificada de antemano.
4. **Selector "Solo ida" / "Con retorno"** (`#ida`): si se elige "Con retorno", `planRuta()` agrega
   automáticamente un tramo final de regreso al punto de **origen** (no a un punto "oficina" con
   nombre propio — es literalmente el mismo origen fijado en el paso 1).
5. El sistema calcula la ruta real por calles con OSRM (distancia y duración por cada tramo) y pinta la
   polilínea en el mapa. El botón inferior muestra el total de km y queda habilitado.
6. **"Iniciar viaje"**: congela esa lista de tramos dentro de `viaje.tramos`, registra la hora de salida
   y arranca el cronómetro + la alarma de llegada estimada.

### 3.2 Durante el viaje (un tramo a la vez)

- La tarjeta "Viaje en curso" muestra: tramo actual (`Tramo X de N`), origen→destino, hora de salida,
  distancia, tiempo transcurrido y llegada estimada.
- Cuando se cumple la hora estimada (`eta`), suena una alarma / notificación "¿Ya llegaste?"
  (con la app en segundo plano o cerrada, la dispara el Service Worker).
- **"✔ Registrar llegada"**: cierra el tramo actual — se guarda como fila en `rutas`, se envía a Google
  Sheets, se recalculan los contadores de combustible/mantenimiento.
  - Si quedan tramos pendientes en `viaje.tramos` → pasa a `esperando:true` ("llegaste, pero todavía no
    sales al siguiente"). El botón cambia a **"▶ Salir al siguiente destino"**: al tocarlo recién ahí se
    registra la nueva hora de salida real (no se asume que salió apenas llegó).
  - Si era el tramo de **regreso a oficina** (`retorno:true`) → el viaje completo termina (`viaje = null`).
  - Si no queda nada planificado y **no** era el regreso → `decidiendo:true`: se abre el panel
    **"¿Qué sigue?"** (ver sección 4).
- **"Agregar destino"** (dentro del viaje en curso, botón aparte del de planificación): permite sumar una
  parada **no planificada** sobre la marcha, usando el mismo mapa + buscador que el resto de la app
  (ya no usa `prompt()`).
- **"Cancelar viaje"**: aborta todo el viaje en curso (con confirmación); lo ya registrado (tramos
  cerrados previamente) se conserva, pero el tramo abierto en ese momento no se guarda.

### 3.3 Contadores automáticos
Cada vez que se cierra un tramo, se sube el odómetro acumulado y se revisa si se cruzó:
- **170 km** → aviso de combustible.
- **1500 km** → aviso de mantenimiento.

---

## 4. Contraste con el flujo descrito (Jose, instalador)

> "Jose tiene un trabajo, usará la movilidad para ir a dicho trabajo. Queremos registrar la hora de
> salida, lugar al que va, kilómetros recorridos. Él puede escoger si retorna a oficina o si puede
> agregar un punto más. Si retorna ahí termina el viaje; si agrega, tiene que esperar a llegar al punto
> antes de terminar y regreso a oficina es el término."

| Necesidad de Jose | ¿La app lo cubre hoy? | Cómo |
|---|---|---|
| Hora de salida | ✅ Sí | `hsal` al iniciar el viaje y en cada `salirAlSiguiente()` |
| Lugar al que va | ✅ Sí | Destino con buscador + mapa, guardado como texto legible |
| Kilómetros recorridos | ✅ Sí | OSRM automático (o odómetro / manual como alternativa) |
| Esperar a llegar antes de "terminar" | ✅ Sí | `esperando:true` bloquea el cierre hasta `registrarLlegada()` |
| Elegir **retorna a oficina** o **agrega un punto más** | ⚠️ **Parcial, y en el momento equivocado** | Ver abajo |

### El punto que no calza: *cuándo* se decide "retorno" vs "otro punto"

Hoy esa decisión (`Solo ida` / `Con retorno`) se toma **una sola vez, al planificar, antes de salir de
origen** — es un selector fijo para todo el viaje, no una pregunta que aparece **al llegar a cada punto**.

Lo que describe Jose es un flujo **decidido en cada parada**:

```
Sale de oficina → llega al Punto A →  ¿Ahora qué? 
                                        ├─ Regresa a oficina  → viaje TERMINA
                                        └─ Va a un Punto B     → espera, sale, llega a B → ¿Ahora qué?
                                                                                            ├─ Regresa a oficina → TERMINA
                                                                                            └─ Punto C… (se repite)
```

La app actual solo se acerca a esto con la combinación de dos mecanismos separados que no están pensados
para trabajar juntos en vivo:

1. **"Con retorno"** — pero es una casilla que se marca *antes* de salir, no una pregunta que aparece
   *al llegar*. Si Jose no sabe todavía si va a volver directo o va a necesitar otra parada, hoy tiene
   que adivinarlo desde el inicio.
2. **"Agregar destino" en pleno viaje** — sí permite sumar una parada sobre la marcha, pero:
   - usa `prompt()` del navegador (fea, sin mapa, sin autocompletado, fácil de cancelar sin querer);
   - no existe como **alternativa** presentada junto a "Regresar a oficina" — son dos flujos que no se
     tocan en la pantalla.
3. **No existe el concepto "Oficina"** como lugar con nombre propio. El "retorno" de hoy vuelve al mismo
   punto que se escribió como Origen al planificar — funciona, pero no hay un botón "Volver a la oficina"
   reconocible ni una oficina guardada como favorito por defecto.

### Qué le faltaría a la app para calzar 1:1 con ese flujo

- En el momento de **registrar la llegada** a un punto (donde hoy solo aparece "✔ Registrar llegada" o
  el tramo pasa a `esperando`), mostrar la pregunta explícita:
  **"¿Retornas a oficina o vas a otro punto?"**, con dos botones, no un `prompt()`.
- Que "oficina" sea un lugar guardado (o el mismo Origen), para poder cerrar el viaje con un solo toque
  en vez de tener que volver a buscar la dirección.
- Que "agregar destino" reutilice el mismo selector de mapa + motivo + entidad que ya existe para el
  primer destino, en vez de los tres `prompt()`.
- La planificación completa por adelantado (elegir 3 destinos y "con retorno" antes de salir) puede
  seguir existiendo como atajo para cuando Jose **sí** sabe su recorrido completo de antemano — pero el
  caso típico que describes (decide en cada parada) necesita el flujo "decidir al llegar" descrito arriba,
  que hoy no existe como tal.

### Estado: implementado

Al registrar la llegada a un punto que **no** tiene otro tramo ya planificado y que **no** es el regreso a
oficina, se abre un panel **"¿Qué sigue?"** con dos botones:

- **"Volver a la oficina"** — calcula por OSRM el tramo de regreso al Origen del viaje, lo agrega como
  `{motivo:'Retorno', entidad:'—', retorno:true}` y pasa a `esperando:true` (falta que Jose realmente
  salga). Al registrar esa llegada, como es `retorno:true`, ahí sí termina el viaje.
- **"Ir a otro punto"** — abre el mismo selector de mapa a pantalla completa que usa el resto de la app
  (ya no `prompt()`), con un formulario corto de Motivo + Entidad; calcula el tramo por OSRM y encadena
  la misma pregunta cuando se llegue a ese nuevo punto. Así se puede seguir sumando puntos indefinidamente
  hasta que en algún momento se elija "Volver a la oficina".

El botón "Agregar destino" (para sumar una parada **antes** de llegar a la actual, mientras se sigue
manejando) usa el mismo mapa + formulario, pero sin la pregunta: solo encola el tramo para después.

La planificación previa (elegir varios destinos y "Con retorno" antes de salir) se mantiene intacta como
atajo para cuando ya se conoce el recorrido completo — el panel "¿Qué sigue?" solo aparece cuando, al
llegar, no queda nada pre-planificado.

El formato que se envía a Google Sheets (`registrarEnNube`) **no cambió**: cada tramo —venga de la
planificación previa, del regreso a oficina o de un punto agregado en vivo— pasa por el mismo
`registrarLlegada()` de siempre y arma la misma fila de columnas.

---

## 5. Otras piezas relevantes de la app (contexto general)

- **Instalación como app** (`manifest.webmanifest`, `sw.js`): ícono en el celular, funciona sin señal,
  puede disparar la notificación de "¿ya llegaste?" con la app cerrada si el navegador soporta
  `showTrigger` (Chrome/Edge Android); si no, cae a revisión periódica (`periodicsync`/`sync`) o cuando
  se reabre la app.
- **Métodos de kilometraje** (`#metodo`, en "Ajustes"): Automático (por calles, default), Odómetro
  (inicial/final), Manual (número tecleado) — pensado para cuando no hay señal para calcular ruta.
- **Envío a Google Sheets**: se configura una URL de Apps Script (`sheetUrl`); cada llegada registrada se
  intenta enviar (`registrarEnNube`); si falla o no hay internet, queda en `cola` para reintento
  (`vaciarCola`).
- **Rutas frecuentes**: combina favoritos guardados a mano (`favUser`) con rutas repetidas ≥2 veces en el
  historial, para iniciar un viaje con un toque.
- **Contadores de combustible/mantenimiento**: puramente derivados de la suma de `km` en `rutas`, sin
  registrar cargas de combustible reales todavía (`cargas`/`mants` existen como arrays pero no hay UI
  para registrarlas manualmente en el HTML actual — están declarados pero no se ven campos para
  alimentarlos fuera del cálculo automático por kilometraje).

---

## 6. Panel de administrador

Ya existía un modo oculto para mostrar la sección "Ajustes" (antes solo tenía Google Sheets, zona y método
de kilometraje): **5 toques seguidos en el logo/nombre de la barra superior**, o abrir la app con
`?config=1` en la URL. Se guarda en `localStorage` (`rr.admin`), así que una vez activado queda activado
en ese dispositivo. Ahora esa sección también incluye:

- **Kilometraje real del vehículo**: dos campos ("Km desde la última carga" / "Km desde el último
  mantenimiento") que se guardan como `kmBaseF`/`kmBaseM`. `recalcular()` arranca los contadores de
  Combustible (170 km) y Mantenimiento (1500 km) desde ahí en vez de desde cero — así, cuando se borra el
  historial de pruebas, los contadores no vuelven a cero: siguen desde el kilometraje real que se cargue.
- **Borrar TODO el historial** (con confirmación): vacía `rutas` y la cola de envío pendiente, **de este
  dispositivo**. Los contadores quedan en el kilometraje base que se haya cargado (no en cero).
- **Borrar un tramo suelto**: con el administrador activo, cada fila del Historial muestra una ✕ para
  borrar solo esa fila (con confirmación, mostrando qué se va a borrar).

**Importante — lo que este panel *no* toca:** nada de esto le pega a Google Sheets. `google-apps-script.gs`
no se modificó (sigue siendo solo-inserción, sin endpoint de borrado), así que **lo que ya se envió a la
hoja hay que limpiarlo a mano, abriendo la hoja de cálculo directamente.**

> ⚠️ **Dato para antes de entregar la app:** durante las pruebas de este cambio (hechas por el asistente,
> con un servidor local) se registraron varios viajes de prueba con el flujo nuevo. Como el campo
> "Google Sheets" ya traía configurada por defecto la URL de producción (`SHEET_URL_DEFECTO` en el código),
> es muy probable que esas filas de prueba (origen "Plaza Huamanmarca", destinos "Real Plaza Huancayo",
> "Universidad Continental", "ISTP Continental", clientes "Cliente Prueba SAC" / "Cliente B" / "Cliente C",
> fecha de hoy) **se hayan escrito en la hoja real**. Conviene revisar la hoja y borrar esas filas a mano
> antes de entregar — el botón "Borrar TODO el historial" de este panel no las toca porque solo borra
> datos del dispositivo, no de la hoja.

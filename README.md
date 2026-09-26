# 3wayClip

Aplicación personal para cargar un vídeo, escribir el texto común y enviarlo a TikTok, YouTube Shorts e Instagram Reels. Node.js 22 o posterior.

## Título y descripción

- **YouTube Shorts:** título obligatorio (hasta 100 caracteres) y descripción separados. El título aparece en el formulario solo al seleccionar YouTube y nunca se añade al texto de las otras redes.
- **Instagram Reels:** se envía la descripción como `caption`, sin título separado.
- **TikTok Direct Post (vídeos):** se envía la descripción en `post_info.title`; pese al nombre del campo de la API, es el texto del vídeo, no un título independiente.
- **TikTok bandeja:** la API recibe solo el vídeo. El botón de copiar permite llevar la descripción a TikTok para pegarla al completar la publicación.

La descripción común es opcional y el editor mantiene un límite de 2.200 caracteres para facilitar compartirla. YouTube admite hasta 5.000 bytes UTF-8 en la descripción, por lo que también se comprueba ese límite (relevante con algunos caracteres Unicode), además de rechazar `<` y `>` al seleccionar YouTube. Este límite común de la interfaz no pretende ser el máximo nativo de YouTube.

## Ejecutar

```powershell
npm install
npm run dev
```

Abre http://localhost:3010. Puedes cambiar el puerto con `$env:PORT='3011'`. Reinicia el proceso tras cambios en el servidor. Se instala FFmpeg y FFprobe en el proyecto; no se usa el FFmpeg antiguo del sistema. Puedes sobrescribir sus rutas con FFMPEG_PATH y FFPROBE_PATH.

## Gameplay 2.0 → vídeo vertical

1. Carga el clip horizontal y pulsa **Crear vertical** junto al reproductor.
2. Se abre el original con dos recortes y la vista vertical al lado. La plantilla inicial se ha medido sobre la captura de referencia: cámara superior derecha y acción del juego en el centro. Usa **Reproducir vista previa** para ver el resultado en movimiento y con sonido; el deslizador permite revisar otros momentos.
3. Elige **Cámara** o **Gameplay** y arrastra sobre el original para dibujar su zona. También puedes ajustar X, Y, ancho y alto en porcentaje. Las zonas se escalan sin deformar y se recortan por el centro para llenar su panel.
4. Puedes colocar la cámara **arriba**, **abajo** o **superpuesta**. En el modo superpuesto se puede arrastrar la cámara sobre el vertical y ajustar su tamaño y posición. Modifica la altura del panel en los otros modos. **Guardar plantilla** conserva el encuadre y el estilo de subtítulos en este navegador.
5. Selecciona Inicio y Fin (hasta 180 segundos). Para clips más largos se proponen los primeros 180 segundos, indicándolo expresamente. El recorte es fijo: no sigue al personaje ni identifica automáticamente los mejores momentos. La plantilla inicial excluye el chat y el minimapa; ajusta la zona si necesitas conservarlos.
6. Activa los subtítulos, selecciona idioma y pista de voz y pulsa **Generar subtítulos**. Revisa las frases y sus tiempos. Puedes corregir, añadir o eliminar texto, cambiar tamaño, color y posición. Si cambias el fragmento, la pista o el idioma, debes regenerar los tiempos antes de exportar. El texto de ejemplo de la vista previa nunca se exporta.
7. Pulsa **Crear vertical**. Se genera un MP4 1080 × 1920 a 30 fps, H.264/AAC con los subtítulos incrustados. Ese archivo pasa a ser el seleccionado para publicar. Se puede revisar con el reproductor nativo, descargarlo o volver al original. El SRT del último render está disponible al volver a abrir el editor.

La composición de la vista previa se actualiza localmente mientras ajustas. La exportación final se hace con FFmpeg; revisa ese archivo para comprobar los saltos de línea y el encuadre exacto. No se modifica el vídeo original. La conversión respeta el audio de la primera pista; la pista elegida para subtítulos solo controla qué voz se transcribe. Si el micrófono está mezclado con el juego u otras voces, el transcriptor no puede aislar automáticamente al streamer.

### Preparar subtítulos locales

Además de Node, se necesita Python 3.10 o posterior. Ejecuta una vez:

```powershell
npm run setup:subtitles
```

Esto crea `.venv`, instala faster-whisper y descarga el modelo multilingüe `base` (aproximadamente 150 MB) en `.data/models/base`. La transcripción posterior usa CPU INT8 y solo archivos locales; no sube voz o vídeo a ningún servicio. El editor muestra si el motor está preparado. Sin el modelo, se puede crear el vertical desactivando subtítulos. La preparación no se ejecuta automáticamente al abrir un clip.

Se generan frases cortas a partir de marcas de tiempo por palabra, con detección de voz. La precisión depende del audio, especialmente con nombres del juego, gritos, música o voces mezcladas; revisa el texto. Un clip sin voz genera una transcripción vacía y no se inventan frases de ejemplo en la exportación.

Los trabajos de transcripción y render muestran progreso y se pueden cancelar. Viven en la sesión del servidor; reiniciarlo interrumpe las ediciones y requiere volver a cargar el original. `SUBTITLE_PYTHON` y `SUBTITLE_MODEL_DIR` permiten usar otro intérprete/modelo local compatible. El SRT y la vista previa usan tiempos relativos al fragmento elegido.

## Audio

La vista previa usa el reproductor nativo del navegador, con sus controles de reproducción y volumen.

**Convertir a MP4 compatible** es opcional para formatos incompatibles con el navegador o las plataformas. Crea una copia H.264/AAC para publicar y descargar, sin modificar el original ni usar pistas de audio externas. Si el archivo no contiene audio, se indica expresamente. En archivos con varias pistas se convierte la primera.

## Conectar cuentas desde la web

Abre **Cuentas y API**. Para cada red, introduce las credenciales de una aplicación de desarrollador, guarda y pulsa **Iniciar sesión**. Se abre la página oficial de autorización. Las contraseñas personales se introducen exclusivamente allí. Permite ventanas emergentes y vuelve a la pestaña original después de autorizar; conserva el vídeo seleccionado.

Las aplicaciones y sus permisos deben crearse en los portales de los proveedores; 3wayClip no puede obtenerlos usando solo tu usuario y contraseña. Los errores de permisos o aprobación se muestran sin simular conexiones exitosas.

### YouTube

1. En [Google Cloud](https://console.cloud.google.com/apis/credentials), habilita YouTube Data API v3.
2. Configura el consentimiento OAuth; si está en pruebas, añade tu cuenta como usuario de prueba.
3. Crea un cliente OAuth de tipo **Aplicación web**. Registra `http://localhost:3010/oauth/youtube/callback` (ajusta PORT si procede).
4. Introduce Client ID y Client Secret y conecta la cuenta que tiene tu canal.

Se solicitan `youtube.upload` y `youtube.readonly` para subir y consultar el resultado. Se usa subida reanudable del proveedor, aunque esta aplicación no reanuda automáticamente una transferencia interrumpida. Elige visibilidad y si el contenido está creado para niños. La API requiere título. Para Shorts se valida orientación vertical o cuadrada y duración de hasta 180 segundos; la clasificación final la realiza YouTube. Los proyectos no auditados pueden tener las subidas limitadas a privado.

### TikTok

1. Crea una app en [TikTok for Developers](https://developers.tiktok.com/), añade Login Kit y Content Posting API y solicita los permisos necesarios.
2. Elige **Desktop** con retorno `http://localhost:3010/oauth/tiktok/callback`, o **Web** con una URL HTTPS pública terminada en `/oauth/tiktok/callback`. El tipo debe coincidir con la configuración de la app.
3. Introduce Client Key y Client Secret y selecciona el modo antes de conectar.

- **Bandeja (predeterminado):** solicita `user.info.basic,video.upload`; envía el archivo, pero debes abrir la notificación de TikTok, añadir el texto y terminar la publicación allí. El endpoint de bandeja de vídeos no permite adjuntar el título o la descripción. También requiere que TikTok apruebe el permiso `video.upload`.
- **Direct Post:** solicita `user.info.basic,video.publish`. Carga la privacidad y permisos de interacción de la cuenta; envía únicamente la descripción común. Incluye opciones de comentarios, Dúo, Pegar, contenido comercial e IA. TikTok restringe clientes no auditados a privado y sus criterios no admiten herramientas exclusivamente personales para aprobar Direct Post. No se puede prometer publicación pública automática para este caso.

### Instagram

1. Crea una aplicación en [Meta for Developers](https://developers.facebook.com/apps/) con **Instagram API con Instagram Login**. Usa una cuenta profesional (creador o empresa).
2. Configura `instagram_business_basic` e `instagram_business_content_publish`. Durante desarrollo, asigna y acepta los roles de prueba correspondientes; para otros usuarios, completa la revisión requerida.
3. Introduce el **Instagram App ID** y su secreto (no el cliente de Google ni las credenciales de Facebook Login).
4. Registra una URL HTTPS pública terminada en `/oauth/instagram/callback`. La versión de Graph API es configurable; valor inicial `v24.0`.
5. En **URL pública para Instagram**, guarda el origen HTTPS de un dominio o túnel que apunte al servidor local. Instagram necesita descargar el archivo desde Internet. No basta con localhost ni con rellenar el campo: el dominio/túnel debe existir y estar funcionando.

Por ejemplo, con un túnel propio `https://clip.example.com` hacia el puerto 3010, registra `https://clip.example.com/oauth/instagram/callback` y guarda `https://clip.example.com` como URL pública. El proxy debe preservar Host o informar X-Forwarded-Host/X-Forwarded-For. No reescribas todas las cabeceras como si la conexión fuera local.

Solo los callbacks OAuth y las URLs de vídeo temporales se atienden públicamente. La pantalla, la configuración y el resto de la API permanecen restringidos a localhost. El retorno público se intercambia por un ticket de un solo uso que debe completar el navegador local que inició la conexión. Una URL de vídeo aleatoria caduca tras una hora. No se despliega ni se abre un túnel automáticamente.

## Publicar y comprobar resultados

Selecciona el vídeo y las redes conectadas. Cada destino muestra sus opciones y la cuenta. **Compartir** sube primero al servidor local y después inicia los envíos de forma concurrente. Los resultados distinguen subida, procesamiento, publicación confirmada, bandeja de TikTok y errores. Un fallo de una red no marca las demás como fallidas.

Se guarda un identificador por envío para que una repetición de la misma petición no duplique publicaciones. El estado se consulta automáticamente; **Comprobar estados** consulta de nuevo al proveedor. Si una respuesta se pierde o el servidor se reinicia, revisa el estado antes de crear otro envío. No se reintenta automáticamente una publicación de resultado incierto. En Instagram, la consulta puede completar la publicación previamente autorizada cuando termine el procesamiento del contenedor.

## Datos locales

- `.data/credentials.enc`: credenciales y tokens cifrados con AES-256-GCM. `.data/key` contiene la clave; ambas se deben proteger juntas. El cifrado no protege frente a alguien con acceso a ambas.
- `.data/jobs.json`: historial y referencias remotas, sin tokens.
- `.data/uploads/`: copias locales y conversiones. Los archivos generados de más de 24 horas se eliminan al arrancar. No se eliminan vídeos originales.
- `.data/editing/`: archivos intermedios de edición, eliminados al finalizar o cancelar cada trabajo.
- `.data/models/` y `.venv/`: modelo de voz y entorno Python local; ambos quedan excluidos de Git.
- El título y la descripción del borrador se guardan en localStorage; los secretos no.

`.data`, `.env` y `node_modules` están excluidos de Git. Los access tokens se renuevan antes de caducar si el proveedor lo permite. **Desconectar** revoca el permiso con el proveedor y, si tiene éxito, elimina la sesión guardada. Los cambios de credenciales requieren volver a conectar.

## Validación

```powershell
npm run check
npm test
```

Las pruebas generan vídeos sintéticos y verifican que la conversión a MP4 conserva audio audible, lectura por rangos, ausencia de audio, rechazo de archivos inválidos, cifrado, protección de origen/CSRF, retorno OAuth ligado a la sesión, renovación de tokens, subida por fragmentos, resultados independientes e idempotencia. Las APIs remotas se simulan en las pruebas: no se publican vídeos reales ni se sustituyen los flujos de producción por simulaciones.

También se renderizan MP4 reales para comprobar dimensiones, duración, posición de cámara en los tres modos, audio y píxeles de subtítulos incrustados. Las pruebas de controles usan un DOM de prueba y canvas simulado para comprobar cambios de plantilla, revisión de texto y selección del resultado; no sustituyen la inspección visual en un navegador ni validan la precisión de reconocimiento de una voz real.

## Documentación de los proveedores

- [Google OAuth para servidores web](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube: subida de vídeos](https://developers.google.com/youtube/v3/docs/videos/insert)
- [TikTok: criterios de Direct Post](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
- [TikTok: envío a bandeja](https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content)
- [TikTok: Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)
- [Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Instagram: publicación de contenido](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing)

---
# Welcome page for the `nebius:safecode` type - es variant. See `welcome.md` for
# the structure; only user-visible values are translated.
greeting: ¿En qué quiere trabajar?
suggestions:
  - title: Comprobar que mi entorno aislado está listo
    description: Qué falta todavía y quién se encarga de cada paso.
    prompt: Comprueba si mi entorno aislado de Nebius está listo para usarse. Ejecuta la comprobación de configuración, dime qué falta y quién debe hacer cada paso, y haz tu parte cuando te lo confirme.
  - title: Sincronizar y ejecutar las pruebas
    description: Sincronizar el espacio de trabajo en un entorno aislado y ejecutar allí la suite de pruebas.
    prompt: Sincroniza este espacio de trabajo en un entorno aislado de Nebius, ejecuta allí la suite de pruebas del proyecto y dime qué ha pasado y qué ha fallado, con la salida relevante. No ejecutes nada en este ordenador.
  - title: Corregir un error y verificarlo en un entorno aislado
    description: Leer aquí, editar aquí, ejecutar las pruebas relevantes en un entorno aislado.
    prompt: Investiga este error leyendo el código, encuentra la causa raíz y aplica la corrección mínima y fiable con SuperEdit. Después sincroniza el espacio de trabajo en un entorno aislado y ejecuta allí las pruebas que cubren el cambio. Dime qué ha mostrado el entorno aislado y qué no has podido verificar.
  - title: Buscarlo en la web
    description: Documentación, un mensaje de error o un registro de cambios, a través de Tavily.
    prompt: Busca en la web lo que haga falta aquí —la documentación de la biblioteca, el mensaje de error exacto o el registro de cambios de la versión en uso—, lee las páginas relevantes y dime qué se aplica a este caso, con las fuentes. Después propone el cambio, si se deriva uno.
  - title: Entender este código
    description: Explorar la arquitectura, los módulos y los flujos importantes.
    prompt: Ayúdame a entender este código leyéndolo. Identifica los componentes principales, los puntos de entrada importantes, el flujo de datos y las partes que debería leer primero.
  - title: Revisar código
    description: Buscar errores, riesgos y oportunidades de mejora.
    prompt: Revisa este código leyéndolo, en cuanto a corrección, errores, regresiones, riesgos de seguridad, problemas de rendimiento y mantenibilidad. Pon primero los hallazgos más importantes. Si un hallazgo necesita una ejecución para confirmarse, dilo y propone confirmarlo en un entorno aislado.
---

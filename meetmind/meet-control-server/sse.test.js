import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SSELib = require('eventsource');

// LOG DE DEPURACIÓN: Vamos a ver qué tiene la librería por dentro
// console.log('Contenido de la librería:', SSELib);

// Buscamos la clase EventSource donde sea que esté escondida
const EventSource = SSELib.default || (SSELib.EventSource ? SSELib.EventSource : SSELib);

const URL = 'http://localhost:3001/meetings/bsu-frno-adr/events/stream';

console.clear();
console.log('🚀 Iniciando Debugger de SSE (v2)...');

try {
  // Verificamos si logramos extraer algo que se pueda instanciar
  if (typeof EventSource !== 'function') {
    throw new Error(`No se pudo encontrar el constructor. Tipo detectado: ${typeof EventSource}`);
  }

  console.log(`📡 Conectando a: ${URL}`);
  const source = new EventSource(URL);

  source.onopen = () => {
    console.log('✅ Conexión establecida con éxito.\n');
  };

  source.addEventListener('connected', (e) => console.log('✨ Connected:', JSON.parse(e.data)));
  source.addEventListener('chat.message.detected', (e) => console.log('💬 Chat:', JSON.parse(e.data)));
  source.addEventListener('heartbeat', () => process.stdout.write('💓 '));

  source.onerror = (err) => {
    console.error('\n❌ Error de red o servidor offline.');
  };

} catch (error) {
  console.error('\n💥 ERROR CRÍTICO:');
  console.error(error.message);
  
  console.log('\n💡 Tip: Si esto falla, intenta instalar la versión beta que tiene mejor soporte ESM:');
  console.log('   npm install eventsource@next');
}

process.on('SIGINT', () => {
  console.log('\n🔌 Saliendo...');
  process.exit();
});
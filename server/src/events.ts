import { EventEmitter } from 'node:events';
import type { SseEvent } from '@automacao/shared';

class AppEventBus extends EventEmitter {
  emitEvent(event: SseEvent) {
    this.emit('sse', event);
  }
  onEvent(listener: (event: SseEvent) => void) {
    this.on('sse', listener);
    return () => this.off('sse', listener);
  }
}

export const bus = new AppEventBus();
bus.setMaxListeners(50);

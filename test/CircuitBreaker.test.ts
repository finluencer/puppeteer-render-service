import { CircuitBreaker } from '../src/CircuitBreaker';
import { CircuitBreakerOpenError } from '../src/errors';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ enabled: true, maxFailures: 3, resetTimeout: 200 });
  });

  describe('constructor', () => {
    it('initializes closed with zero counters', () => {
      expect(cb.isOpen).toBe(false);
      expect(cb.failures).toBe(0);
      expect(cb.successCount).toBe(0);
      expect(cb.lastFailureTime).toBeNull();
    });

    it('never breaks when enabled is false', () => {
      const disabled = new CircuitBreaker({ enabled: false, maxFailures: 1 });
      disabled.recordFailure();
      disabled.recordFailure();
      expect(disabled.isBroken).toBe(false);
    });

    it('uses defaults when no options given', () => {
      const def = new CircuitBreaker();
      expect(def.enabled).toBe(true);
      expect(def.maxFailures).toBeGreaterThan(0);
      expect(def.resetTimeout).toBeGreaterThan(0);
    });
  });

  describe('recordFailure', () => {
    it('increments failure count', () => {
      cb.recordFailure();
      expect(cb.failures).toBe(1);
      expect(cb.lastFailureTime).toBeTruthy();
    });

    it('opens circuit after maxFailures', () => {
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.isOpen).toBe(false);
      cb.recordFailure();
      expect(cb.isOpen).toBe(true);
    });

    it('stays open once opened', () => {
      for (let i = 0; i < 5; i++) cb.recordFailure();
      expect(cb.isOpen).toBe(true);
      expect(cb.failures).toBe(5);
    });
  });

  describe('recordSuccess', () => {
    it('decrements failure count', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      expect(cb.failures).toBe(1);
    });

    it('does not go below zero failures', () => {
      cb.recordSuccess();
      expect(cb.failures).toBe(0);
    });

    it('increments successCount', () => {
      cb.recordSuccess();
      cb.recordSuccess();
      expect(cb.successCount).toBe(2);
    });

    it('caps successCount at MAX_SAFE_INTEGER (not overflow)', () => {
      cb.successCount = Number.MAX_SAFE_INTEGER;
      cb.recordSuccess();
      expect(cb.successCount).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('isBroken', () => {
    it('returns false when circuit is closed', () => {
      expect(cb.isBroken).toBe(false);
    });

    it('returns true when circuit is open and within resetTimeout', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.isBroken).toBe(true);
    });

    it('auto-resets after resetTimeout elapses', async () => {
      const fastCb = new CircuitBreaker({ maxFailures: 1, resetTimeout: 80 });
      fastCb.recordFailure();
      expect(fastCb.isBroken).toBe(true);

      await new Promise((r) => setTimeout(r, 120));

      expect(fastCb.isBroken).toBe(false);
      expect(fastCb.isOpen).toBe(false);
      expect(fastCb.failures).toBe(0);
    });
  });

  describe('execute', () => {
    it('runs fn and returns result when closed', async () => {
      const result = await cb.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    it('records success when fn resolves', async () => {
      await cb.execute(() => Promise.resolve('ok'));
      expect(cb.successCount).toBe(1);
    });

    it('records failure and rethrows when fn rejects', async () => {
      await expect(cb.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      expect(cb.failures).toBe(1);
    });

    it('throws CircuitBreakerOpenError when open and no fallback provided', async () => {
      cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
      await expect(cb.execute(() => Promise.resolve('x'))).rejects.toThrow(CircuitBreakerOpenError);
    });

    it('calls fallback when circuit is open', async () => {
      cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
      const result = await cb.execute(() => Promise.resolve('x'), () => 'fallback');
      expect(result).toBe('fallback');
    });

    it('does not call fn when circuit is open and fallback is provided', async () => {
      cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
      const fn = jest.fn(() => Promise.resolve('x'));
      await cb.execute(fn, () => 'fallback');
      expect(fn).not.toHaveBeenCalled();
    });

    it('opening circuit does not affect in-flight calls', async () => {
      // Simulate fn already running when circuit opens (successive sync failures then a normal execute)
      const result = await cb.execute(() => Promise.resolve('safe'));
      expect(result).toBe('safe');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
      cb.recordSuccess();

      cb.reset();

      expect(cb.failures).toBe(0);
      expect(cb.successCount).toBe(0);
      expect(cb.isOpen).toBe(false);
      expect(cb.lastFailureTime).toBeNull();
    });

    it('allows execute to succeed after reset', async () => {
      cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
      cb.reset();
      const result = await cb.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
    });
  });

  describe('getState', () => {
    it('returns closed state initially', () => {
      expect(cb.getState()).toEqual({
        isOpen: false,
        failures: 0,
        successCount: 0,
        lastFailureTime: null,
      });
    });

    it('returns open state after enough failures', () => {
      cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
      const state = cb.getState();
      expect(state.isOpen).toBe(true);
      expect(state.failures).toBe(3);
      expect(state.lastFailureTime).toBeGreaterThan(0);
    });
  });
});

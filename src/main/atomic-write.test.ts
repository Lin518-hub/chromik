import { describe, expect, it, vi } from 'vitest';
import { atomicWriteFile, type AtomicWriteOperations } from './atomic-write';

function operations(overrides: Partial<AtomicWriteOperations> = {}): AtomicWriteOperations {
  return {
    writeExclusive: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('atomic write fault injection', () => {
  it('cleans its temporary file and never publishes when the disk is full', async () => {
    const diskFull = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const ops = operations({ writeExclusive: vi.fn(async () => { throw diskFull; }) });
    await expect(atomicWriteFile('/output/final.tiff', new Uint8Array([1, 2, 3]), ops)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(ops.rename).not.toHaveBeenCalled();
    expect(ops.remove).toHaveBeenCalledOnce();
    expect(vi.mocked(ops.remove).mock.calls[0][0]).toMatch(/^\/output\/final\.tiff\.filmlab-.+\.tmp$/);
  });

  it('removes a complete temporary file when final rename fails', async () => {
    const ops = operations({ rename: vi.fn(async () => { throw new Error('rename interrupted'); }) });
    await expect(atomicWriteFile('/output/final.png', 'encoded', ops)).rejects.toThrow('rename interrupted');
    expect(ops.writeExclusive).toHaveBeenCalledOnce();
    expect(ops.remove).toHaveBeenCalledWith(vi.mocked(ops.writeExclusive).mock.calls[0][0]);
  });

  it('syncs the temporary file before the rename publishes it', async () => {
    const order: string[] = [];
    const ops = operations({
      writeExclusive: vi.fn(async () => { order.push('write'); }),
      sync: vi.fn(async () => { order.push('sync'); }),
      rename: vi.fn(async () => { order.push('rename'); }),
    });
    await atomicWriteFile('/output/final.chpx', new Uint8Array([1]), ops);
    expect(order).toEqual(['write', 'sync', 'rename']);
    expect(vi.mocked(ops.sync)!.mock.calls[0][0]).toBe(vi.mocked(ops.writeExclusive).mock.calls[0][0]);
  });

  it('removes the temporary file and never renames when fsync fails', async () => {
    const ops = operations({ sync: vi.fn(async () => { throw new Error('EIO'); }) });
    await expect(atomicWriteFile('/output/final.chpx', new Uint8Array([1]), ops)).rejects.toThrow('EIO');
    expect(ops.rename).not.toHaveBeenCalled();
    expect(ops.remove).toHaveBeenCalledOnce();
  });
});

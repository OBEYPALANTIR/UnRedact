import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileToBase64 } from './pdf';

describe('fileToBase64', () => {
  beforeEach(() => {
    // Clear any previous mocks
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should successfully convert a file to base64', async () => {
    // 1. Create a dummy file
    const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });

    // 2. We need to mock FileReader using a class since it is instantiated with `new`
    class MockFileReader {
      readAsDataURL = vi.fn();
      result = 'data:text/plain;base64,aGVsbG8gd29ybGQ=';
      onload: (() => void) | null = null;
      onerror: ((error: Error) => void) | null = null;

      constructor() {
        // We set the mock implementation of readAsDataURL inside the constructor
        // so it triggers the onload correctly
        this.readAsDataURL.mockImplementation(() => {
          setTimeout(() => {
            if (this.onload) {
              this.onload();
            }
          }, 0);
        });
      }
    }

    // Replace the global FileReader
    let createdInstance: MockFileReader | null = null;
    vi.stubGlobal('FileReader', class {
      constructor() {
        createdInstance = new MockFileReader();
        return createdInstance;
      }
    });

    // 3. Call the function
    const result = await fileToBase64(file);

    // 4. Verify
    expect(createdInstance).not.toBeNull();
    expect(createdInstance!.readAsDataURL).toHaveBeenCalledWith(file);
    expect(result).toBe('aGVsbG8gd29ybGQ=');
  });

  it('should reject when FileReader encounters an error', async () => {
    // 1. Create a dummy file
    const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });
    const mockError = new Error('File read failed');

    // 2. We need to mock FileReader
    class MockFileReader {
      readAsDataURL = vi.fn();
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: ((error: Error) => void) | null = null;

      constructor() {
        // We set the mock implementation of readAsDataURL inside the constructor
        // so it triggers the onerror correctly
        this.readAsDataURL.mockImplementation(() => {
          setTimeout(() => {
            if (this.onerror) {
              this.onerror(mockError);
            }
          }, 0);
        });
      }
    }

    let createdInstance: MockFileReader | null = null;
    vi.stubGlobal('FileReader', class {
      constructor() {
        createdInstance = new MockFileReader();
        return createdInstance;
      }
    });

    // 3 & 4. Call the function and verify it rejects with our error
    await expect(fileToBase64(file)).rejects.toThrow('File read failed');
    expect(createdInstance).not.toBeNull();
    expect(createdInstance!.readAsDataURL).toHaveBeenCalledWith(file);
  });
});

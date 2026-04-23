import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommissionLock, { COMMISSION_SESSION_KEY, hashPin } from '@/components/CommissionLock';

beforeEach(() => {
  sessionStorage.clear();
});

describe('CommissionLock', () => {
  it('hashes pin input consistently', async () => {
    await expect(hashPin('1234')).resolves.toBe(await hashPin('1234'));
  });

  it('sets and unlocks the commission area with a PIN', async () => {
    const onPinHashChange = vi.fn();
    render(
      <CommissionLock pinHash={null} onPinHashChange={onPinHashChange}>
        <div>Unlocked content</div>
      </CommissionLock>,
    );

    const inputs = screen.getAllByPlaceholderText(/pin/i);
    fireEvent.change(inputs[0], { target: { value: '2468' } });
    fireEvent.change(inputs[1], { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set PIN' }));

    await waitFor(() => expect(onPinHashChange).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(COMMISSION_SESSION_KEY)).toBe('true');
  });
});

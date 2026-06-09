declare global {
  namespace App {
    interface Locals {
      user: { id: number; email: string } | null;
      consumer: { id: number; roleId: number; displayName: string } | null;
    }
  }
}
export {};

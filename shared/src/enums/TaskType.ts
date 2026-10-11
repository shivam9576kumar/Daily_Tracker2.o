export type TaskType = 'new' | 'revision' | 'assignment' | 'potd' | 'personal' | 'cp31' | 'cses';

export const TaskType = {
  NEW: 'new' as const,
  REVISION: 'revision' as const,
  ASSIGNMENT: 'assignment' as const,
  POTD: 'potd' as const,
  PERSONAL: 'personal' as const,
  CP31: 'cp31' as const,
  CSES: 'cses' as const,
};


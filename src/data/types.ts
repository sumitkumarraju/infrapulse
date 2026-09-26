/* The contract with the backend lives in shared/ so the server and the client
 * cannot drift. This file exists so app code can keep importing from
 * '@/data/types'. */

export * from '@shared/contract'

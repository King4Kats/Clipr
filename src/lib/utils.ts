import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utilitaire de gestion des classes CSS utilisant clsx et tailwind-merge.
 * Permet de concaténer des classes conditionnelles tout en résolvant les conflits Tailwind.
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

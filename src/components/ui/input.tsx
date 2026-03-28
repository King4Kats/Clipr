/**
 * INPUT.TSX : Champ de saisie texte (ShadCN/UI)
 *
 * Encapsule l'élément HTML natif <input> avec des styles Tailwind cohérents :
 * bordures, arrondis, focus ring, gestion du placeholder et support des
 * champs de type fichier (file input).
 *
 * Logique générale :
 * - Composant pur sans état interne : il reçoit value/onChange du parent.
 * - forwardRef permet au parent d'accéder au DOM natif (ex: videoRef.current.focus()).
 * - Les styles sont responsives : text-base sur mobile, text-sm sur desktop (md:).
 * - Le style file: gère l'apparence des <input type="file">.
 *
 * Utilisé par : VideoPreview (renommage de segment dans la barre d'en-tête).
 */

// --- Imports des dépendances ---
import * as React from "react";

import { cn } from "@/lib/utils";

// --- Composant Input ---
// Champ de saisie générique avec forwarding de ref pour accès DOM direct
// Supporte tous les types HTML natifs (text, email, password, file, etc.)
// Styles adaptatifs : taille responsive (text-base mobile, text-sm desktop),
// anneau de focus visible, et opacité réduite quand désactivé
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

// --- Export ---
export { Input };

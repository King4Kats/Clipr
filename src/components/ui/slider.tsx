/**
 * SLIDER.TSX : Curseur de valeur (ShadCN/Radix UI)
 *
 * Permet à l'utilisateur de choisir une valeur (ou une plage) en faisant
 * glisser un curseur le long d'une piste horizontale. Accessible au clavier
 * (flèches gauche/droite) et au tactile grâce au primitif Radix UI Slider.
 *
 * Logique générale :
 * - Composé de 3 parties visuelles imbriquées :
 *   Track (piste grise) > Range (remplissage coloré) > Thumb (bouton draggable).
 * - Le Range se redimensionne automatiquement selon la valeur courante.
 * - Radix gère le drag, le clavier, et les valeurs min/max/step en interne.
 * - Le parent écoute onValueChange pour récupérer la nouvelle valeur.
 *
 * Utilisé par : VideoPreview (contrôle du volume audio du lecteur vidéo).
 */

// --- Imports des dependances ---
import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

// --- Import de l'utilitaire de fusion de classes CSS ---
import { cn } from "@/lib/utils";

// --- Composant Slider : curseur de selection de valeur ---
// Compose de trois parties :
// - Track : la piste de fond (barre grise complete)
// - Range : la zone coloree entre le minimum et la position du curseur
// - Thumb : le bouton draggable que l'utilisateur deplace
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none select-none items-center", className)}
    {...props}
  >
    {/* Track : piste de fond du slider */}
    <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
      {/* Range : zone de remplissage coloree (du minimum a la position du curseur) */}
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    {/* Thumb : bouton draggable avec bordure et anneau de focus */}
    <SliderPrimitive.Thumb className="block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

// --- Export du composant ---
export { Slider };

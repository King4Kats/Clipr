/**
 * BUTTON.TSX : Composant bouton réutilisable (ShadCN/UI)
 *
 * Brique de base la plus utilisée de l'application. Offre 6 variantes de style
 * (default, destructive, outline, secondary, ghost, link) et 4 tailles (default, sm, lg, icon).
 *
 * Logique générale :
 * - Utilise class-variance-authority (CVA) pour gérer les combinaisons de styles
 *   sans conditions manuelles : on déclare les variantes, CVA génère les classes.
 * - Le prop `asChild` (via Radix Slot) permet de transformer un autre élément
 *   (ex: <a>, <Link>) en bouton visuellement, sans imbriquer un <button> dans un <a>.
 * - forwardRef transmet la ref DOM au parent pour focus programmatique ou mesures.
 *
 * Utilisé par : AIAnalysisPanel, EditorLayout, Header, ProgressPanel,
 * SegmentTimeline, Timeline, VideoPreview (contrôles play/pause, export, ajout segment, etc.)
 */

// Imports React, Slot Radix pour le polymorphisme, CVA pour les variantes, utilitaire de classes
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Définition des variantes de style et de taille du bouton via CVA
// Variantes de style :
// - default : fond primaire (bouton principal)
// - destructive : fond rouge (action dangereuse)
// - outline : bordure seule (bouton secondaire léger)
// - secondary : fond secondaire
// - ghost : transparent, visible au survol uniquement
// - link : style de lien hypertexte souligné
// Variantes de taille :
// - default : hauteur 40px
// - sm : hauteur 36px (petit)
// - lg : hauteur 44px (grand)
// - icon : carré 40x40px (bouton icône)
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Interface des props du bouton : attributs HTML natifs + variantes CVA + option asChild
// asChild permet de rendre un autre élément (ex: <a>) avec les styles du bouton
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

// Composant Button : utilise Slot (polymorphisme) si asChild est activé, sinon balise <button>
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

// Export du composant et de ses variantes (réutilisées par d'autres composants comme AlertDialog)
export { Button, buttonVariants };

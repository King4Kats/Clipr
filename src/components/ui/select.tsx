/**
 * SELECT.TSX : Liste déroulante de sélection (ShadCN/Radix UI)
 *
 * Menu déroulant accessible avec groupes, labels et défilement.
 * Regroupe tous les sous-composants nécessaires : déclencheur (trigger),
 * contenu (dropdown), éléments sélectionnables, labels de groupe,
 * séparateurs et boutons de défilement.
 *
 * Logique générale :
 * - Basé sur @radix-ui/react-select qui gère toute l'accessibilité (ARIA,
 *   navigation clavier, focus trap) et le positionnement automatique.
 * - Le contenu s'affiche dans un Portal (hors du flux DOM) pour éviter
 *   les problèmes de z-index et d'overflow des conteneurs parents.
 * - Mode "popper" : le dropdown se positionne dynamiquement au-dessus
 *   ou en-dessous du trigger selon l'espace disponible.
 * - Chaque SelectItem affiche une coche (Check) quand sélectionné.
 *
 * Utilisé par : AIAnalysisPanel (sélection du modèle Whisper, modèle LLM, langue).
 */

// --- Imports des dependances ---
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
// Icones : coche de selection, chevrons haut/bas pour le defilement
import { Check, ChevronDown, ChevronUp } from "lucide-react";

// --- Import de l'utilitaire de fusion de classes CSS ---
import { cn } from "@/lib/utils";

// --- Re-export directs des primitifs Radix sans personnalisation ---
// Select : composant racine qui gere l'etat ouvert/ferme et la valeur selectionnee
const Select = SelectPrimitive.Root;

// SelectGroup : regroupe visuellement plusieurs options sous un meme label
const SelectGroup = SelectPrimitive.Group;

// SelectValue : affiche la valeur actuellement selectionnee dans le trigger
const SelectValue = SelectPrimitive.Value;

// --- Composant SelectTrigger : bouton qui ouvre le menu deroulant ---
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

// --- Composant SelectScrollUpButton : bouton de defilement vers le haut ---
// Affiche un chevron en haut de la liste quand il y a du contenu au-dessus.
const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

// --- Composant SelectScrollDownButton : bouton de defilement vers le bas ---
// Affiche un chevron en bas de la liste quand il y a du contenu en dessous.
const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

// --- Composant SelectContent : panneau deroulant contenant les options ---
// S'affiche dans un portail (hors du DOM parent) avec animations d'ouverture/fermeture.
// Inclut automatiquement les boutons de defilement haut et bas.
const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        position === "popper" &&
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className,
      )}
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          "p-1",
          position === "popper" &&
            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

// --- Composant SelectLabel : etiquette de titre pour un groupe d'options ---
const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

// --- Composant SelectItem : une option selectionnable dans la liste ---
// Affiche une coche a gauche quand l'option est selectionnee.
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 focus:bg-accent focus:text-accent-foreground",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

// --- Composant SelectSeparator : ligne de separation entre groupes d'options ---
const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

// --- Export de tous les sous-composants du Select ---
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};

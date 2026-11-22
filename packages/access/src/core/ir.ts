export type AccessIrSubject =
  | {
      readonly kind: "type";
      readonly wireName: string;
      readonly expiration?: true;
    }
  | {
      readonly kind: "userset";
      readonly wireName: string;
      readonly relation: string;
      readonly expiration?: true;
    }
  | {
      readonly kind: "wildcard";
      readonly wireName: string;
      readonly expiration?: true;
    };

export type AccessIrRole = {
  readonly name: string;
  readonly subjects: readonly AccessIrSubject[];
};

export type AccessIrTerm =
  | { readonly kind: "role"; readonly name: string }
  | { readonly kind: "permission"; readonly name: string }
  | {
      readonly kind: "through";
      readonly roleName: string;
      readonly targetPermission: string;
    }
  | {
      readonly kind: "through-all";
      readonly roleName: string;
      readonly targetPermission: string;
    }
  | {
      readonly kind: "gated";
      readonly term: AccessIrTerm;
      readonly condition: AccessIrTerm;
    }
  | {
      readonly kind: "excluding";
      readonly term: AccessIrTerm;
      readonly banned: AccessIrTerm;
    }
  | {
      readonly kind: "both";
      readonly left: AccessIrTerm;
      readonly right: AccessIrTerm;
    }
  | {
      readonly kind: "or";
      readonly terms: readonly AccessIrTerm[];
    };

export type AccessIrPermission = {
  readonly name: string;
  readonly terms: readonly AccessIrTerm[];
};

export type AccessIrDefinition = {
  readonly wireName: string;
  readonly roles: readonly AccessIrRole[];
  readonly permissions: readonly AccessIrPermission[];
};

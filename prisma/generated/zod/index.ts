import type { Prisma } from "@prisma/client";
import { z } from "zod";

/////////////////////////////////////////
// HELPER FUNCTIONS
/////////////////////////////////////////

/////////////////////////////////////////
// ENUMS
/////////////////////////////////////////

export const TransactionIsolationLevelSchema = z.enum([
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable",
]);

export const UserScalarFieldEnumSchema = z.enum([
  "id",
  "privyUserId",
  "createdAt",
  "updatedAt",
]);

export const DeviceScalarFieldEnumSchema = z.enum([
  "id",
  "userId",
  "name",
  "os",
  "pushToken",
  "expoToken",
  "createdAt",
  "updatedAt",
]);

export const DeviceIdentityScalarFieldEnumSchema = z.enum([
  "id",
  "userId",
  "xmtpId",
  "privyAddress",
  "createdAt",
  "updatedAt",
]);

export const IdentitiesOnDeviceScalarFieldEnumSchema = z.enum([
  "deviceId",
  "identityId",
]);

export const ProfileScalarFieldEnumSchema = z.enum([
  "id",
  "deviceIdentityId",
  "name",
  "username",
  "description",
  "avatar",
  "createdAt",
  "updatedAt",
]);

export const ConversationMetadataScalarFieldEnumSchema = z.enum([
  "id",
  "deviceIdentityId",
  "conversationId",
  "pinned",
  "unread",
  "deleted",
  "readUntil",
  "createdAt",
  "updatedAt",
]);

export const SortOrderSchema = z.enum(["asc", "desc"]);

export const QueryModeSchema = z.enum(["default", "insensitive"]);

export const NullsOrderSchema = z.enum(["first", "last"]);

export const DeviceOSSchema = z.enum(["ios", "android", "web", "macos"]);

export type DeviceOSType = z.infer<typeof DeviceOSSchema>;

/////////////////////////////////////////
// MODELS
/////////////////////////////////////////

/////////////////////////////////////////
// USER SCHEMA
/////////////////////////////////////////

export const UserSchema = z.object({
  id: z.string().uuid(),
  privyUserId: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type User = z.infer<typeof UserSchema>;

/////////////////////////////////////////
// DEVICE SCHEMA
/////////////////////////////////////////

export const DeviceSchema = z.object({
  os: DeviceOSSchema,
  id: z.string().uuid(),
  userId: z.string(),
  name: z.string().nullable(),
  pushToken: z.string().nullable(),
  expoToken: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Device = z.infer<typeof DeviceSchema>;

/////////////////////////////////////////
// DEVICE IDENTITY SCHEMA
/////////////////////////////////////////

export const DeviceIdentitySchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  xmtpId: z.string().nullable(),
  privyAddress: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

/////////////////////////////////////////
// IDENTITIES ON DEVICE SCHEMA
/////////////////////////////////////////

export const IdentitiesOnDeviceSchema = z.object({
  deviceId: z.string(),
  identityId: z.string(),
});

export type IdentitiesOnDevice = z.infer<typeof IdentitiesOnDeviceSchema>;

/////////////////////////////////////////
// PROFILE SCHEMA
/////////////////////////////////////////

export const ProfileSchema = z.object({
  id: z.string().uuid(),
  deviceIdentityId: z.string(),
  name: z.string(),
  username: z.string(),
  description: z.string().nullable(),
  avatar: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/////////////////////////////////////////
// CONVERSATION METADATA SCHEMA
/////////////////////////////////////////

export const ConversationMetadataSchema = z.object({
  id: z.string().uuid(),
  deviceIdentityId: z.string(),
  conversationId: z.string(),
  pinned: z.boolean(),
  unread: z.boolean(),
  deleted: z.boolean(),
  readUntil: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type ConversationMetadata = z.infer<typeof ConversationMetadataSchema>;

/////////////////////////////////////////
// SELECT & INCLUDE
/////////////////////////////////////////

// USER
//------------------------------------------------------

export const UserIncludeSchema: z.ZodType<Prisma.UserInclude> = z
  .object({
    devices: z
      .union([z.boolean(), z.lazy(() => DeviceFindManyArgsSchema)])
      .optional(),
    DeviceIdentity: z
      .union([z.boolean(), z.lazy(() => DeviceIdentityFindManyArgsSchema)])
      .optional(),
    _count: z
      .union([z.boolean(), z.lazy(() => UserCountOutputTypeArgsSchema)])
      .optional(),
  })
  .strict();

export const UserArgsSchema: z.ZodType<Prisma.UserDefaultArgs> = z
  .object({
    select: z.lazy(() => UserSelectSchema).optional(),
    include: z.lazy(() => UserIncludeSchema).optional(),
  })
  .strict();

export const UserCountOutputTypeArgsSchema: z.ZodType<Prisma.UserCountOutputTypeDefaultArgs> =
  z
    .object({
      select: z.lazy(() => UserCountOutputTypeSelectSchema).nullish(),
    })
    .strict();

export const UserCountOutputTypeSelectSchema: z.ZodType<Prisma.UserCountOutputTypeSelect> =
  z
    .object({
      devices: z.boolean().optional(),
      DeviceIdentity: z.boolean().optional(),
    })
    .strict();

export const UserSelectSchema: z.ZodType<Prisma.UserSelect> = z
  .object({
    id: z.boolean().optional(),
    privyUserId: z.boolean().optional(),
    createdAt: z.boolean().optional(),
    updatedAt: z.boolean().optional(),
    devices: z
      .union([z.boolean(), z.lazy(() => DeviceFindManyArgsSchema)])
      .optional(),
    DeviceIdentity: z
      .union([z.boolean(), z.lazy(() => DeviceIdentityFindManyArgsSchema)])
      .optional(),
    _count: z
      .union([z.boolean(), z.lazy(() => UserCountOutputTypeArgsSchema)])
      .optional(),
  })
  .strict();

// DEVICE
//------------------------------------------------------

export const DeviceIncludeSchema: z.ZodType<Prisma.DeviceInclude> = z
  .object({
    user: z.union([z.boolean(), z.lazy(() => UserArgsSchema)]).optional(),
    identities: z
      .union([z.boolean(), z.lazy(() => IdentitiesOnDeviceFindManyArgsSchema)])
      .optional(),
    _count: z
      .union([z.boolean(), z.lazy(() => DeviceCountOutputTypeArgsSchema)])
      .optional(),
  })
  .strict();

export const DeviceArgsSchema: z.ZodType<Prisma.DeviceDefaultArgs> = z
  .object({
    select: z.lazy(() => DeviceSelectSchema).optional(),
    include: z.lazy(() => DeviceIncludeSchema).optional(),
  })
  .strict();

export const DeviceCountOutputTypeArgsSchema: z.ZodType<Prisma.DeviceCountOutputTypeDefaultArgs> =
  z
    .object({
      select: z.lazy(() => DeviceCountOutputTypeSelectSchema).nullish(),
    })
    .strict();

export const DeviceCountOutputTypeSelectSchema: z.ZodType<Prisma.DeviceCountOutputTypeSelect> =
  z
    .object({
      identities: z.boolean().optional(),
    })
    .strict();

export const DeviceSelectSchema: z.ZodType<Prisma.DeviceSelect> = z
  .object({
    id: z.boolean().optional(),
    userId: z.boolean().optional(),
    name: z.boolean().optional(),
    os: z.boolean().optional(),
    pushToken: z.boolean().optional(),
    expoToken: z.boolean().optional(),
    createdAt: z.boolean().optional(),
    updatedAt: z.boolean().optional(),
    user: z.union([z.boolean(), z.lazy(() => UserArgsSchema)]).optional(),
    identities: z
      .union([z.boolean(), z.lazy(() => IdentitiesOnDeviceFindManyArgsSchema)])
      .optional(),
    _count: z
      .union([z.boolean(), z.lazy(() => DeviceCountOutputTypeArgsSchema)])
      .optional(),
  })
  .strict();

// DEVICE IDENTITY
//------------------------------------------------------

export const DeviceIdentityIncludeSchema: z.ZodType<Prisma.DeviceIdentityInclude> =
  z
    .object({
      profile: z
        .union([z.boolean(), z.lazy(() => ProfileArgsSchema)])
        .optional(),
      conversationMetadata: z
        .union([
          z.boolean(),
          z.lazy(() => ConversationMetadataFindManyArgsSchema),
        ])
        .optional(),
      devices: z
        .union([
          z.boolean(),
          z.lazy(() => IdentitiesOnDeviceFindManyArgsSchema),
        ])
        .optional(),
      user: z.union([z.boolean(), z.lazy(() => UserArgsSchema)]).optional(),
      _count: z
        .union([
          z.boolean(),
          z.lazy(() => DeviceIdentityCountOutputTypeArgsSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityArgsSchema: z.ZodType<Prisma.DeviceIdentityDefaultArgs> =
  z
    .object({
      select: z.lazy(() => DeviceIdentitySelectSchema).optional(),
      include: z.lazy(() => DeviceIdentityIncludeSchema).optional(),
    })
    .strict();

export const DeviceIdentityCountOutputTypeArgsSchema: z.ZodType<Prisma.DeviceIdentityCountOutputTypeDefaultArgs> =
  z
    .object({
      select: z.lazy(() => DeviceIdentityCountOutputTypeSelectSchema).nullish(),
    })
    .strict();

export const DeviceIdentityCountOutputTypeSelectSchema: z.ZodType<Prisma.DeviceIdentityCountOutputTypeSelect> =
  z
    .object({
      conversationMetadata: z.boolean().optional(),
      devices: z.boolean().optional(),
    })
    .strict();

export const DeviceIdentitySelectSchema: z.ZodType<Prisma.DeviceIdentitySelect> =
  z
    .object({
      id: z.boolean().optional(),
      userId: z.boolean().optional(),
      xmtpId: z.boolean().optional(),
      privyAddress: z.boolean().optional(),
      createdAt: z.boolean().optional(),
      updatedAt: z.boolean().optional(),
      profile: z
        .union([z.boolean(), z.lazy(() => ProfileArgsSchema)])
        .optional(),
      conversationMetadata: z
        .union([
          z.boolean(),
          z.lazy(() => ConversationMetadataFindManyArgsSchema),
        ])
        .optional(),
      devices: z
        .union([
          z.boolean(),
          z.lazy(() => IdentitiesOnDeviceFindManyArgsSchema),
        ])
        .optional(),
      user: z.union([z.boolean(), z.lazy(() => UserArgsSchema)]).optional(),
      _count: z
        .union([
          z.boolean(),
          z.lazy(() => DeviceIdentityCountOutputTypeArgsSchema),
        ])
        .optional(),
    })
    .strict();

// IDENTITIES ON DEVICE
//------------------------------------------------------

export const IdentitiesOnDeviceIncludeSchema: z.ZodType<Prisma.IdentitiesOnDeviceInclude> =
  z
    .object({
      device: z.union([z.boolean(), z.lazy(() => DeviceArgsSchema)]).optional(),
      identity: z
        .union([z.boolean(), z.lazy(() => DeviceIdentityArgsSchema)])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceDefaultArgs> =
  z
    .object({
      select: z.lazy(() => IdentitiesOnDeviceSelectSchema).optional(),
      include: z.lazy(() => IdentitiesOnDeviceIncludeSchema).optional(),
    })
    .strict();

export const IdentitiesOnDeviceSelectSchema: z.ZodType<Prisma.IdentitiesOnDeviceSelect> =
  z
    .object({
      deviceId: z.boolean().optional(),
      identityId: z.boolean().optional(),
      device: z.union([z.boolean(), z.lazy(() => DeviceArgsSchema)]).optional(),
      identity: z
        .union([z.boolean(), z.lazy(() => DeviceIdentityArgsSchema)])
        .optional(),
    })
    .strict();

// PROFILE
//------------------------------------------------------

export const ProfileIncludeSchema: z.ZodType<Prisma.ProfileInclude> = z
  .object({
    deviceIdentity: z
      .union([z.boolean(), z.lazy(() => DeviceIdentityArgsSchema)])
      .optional(),
  })
  .strict();

export const ProfileArgsSchema: z.ZodType<Prisma.ProfileDefaultArgs> = z
  .object({
    select: z.lazy(() => ProfileSelectSchema).optional(),
    include: z.lazy(() => ProfileIncludeSchema).optional(),
  })
  .strict();

export const ProfileSelectSchema: z.ZodType<Prisma.ProfileSelect> = z
  .object({
    id: z.boolean().optional(),
    deviceIdentityId: z.boolean().optional(),
    name: z.boolean().optional(),
    username: z.boolean().optional(),
    description: z.boolean().optional(),
    avatar: z.boolean().optional(),
    createdAt: z.boolean().optional(),
    updatedAt: z.boolean().optional(),
    deviceIdentity: z
      .union([z.boolean(), z.lazy(() => DeviceIdentityArgsSchema)])
      .optional(),
  })
  .strict();

// CONVERSATION METADATA
//------------------------------------------------------

export const ConversationMetadataIncludeSchema: z.ZodType<Prisma.ConversationMetadataInclude> =
  z
    .object({
      deviceIdentity: z
        .union([z.boolean(), z.lazy(() => DeviceIdentityArgsSchema)])
        .optional(),
    })
    .strict();

export const ConversationMetadataArgsSchema: z.ZodType<Prisma.ConversationMetadataDefaultArgs> =
  z
    .object({
      select: z.lazy(() => ConversationMetadataSelectSchema).optional(),
      include: z.lazy(() => ConversationMetadataIncludeSchema).optional(),
    })
    .strict();

export const ConversationMetadataSelectSchema: z.ZodType<Prisma.ConversationMetadataSelect> =
  z
    .object({
      id: z.boolean().optional(),
      deviceIdentityId: z.boolean().optional(),
      conversationId: z.boolean().optional(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.boolean().optional(),
      createdAt: z.boolean().optional(),
      updatedAt: z.boolean().optional(),
      deviceIdentity: z
        .union([z.boolean(), z.lazy(() => DeviceIdentityArgsSchema)])
        .optional(),
    })
    .strict();

/////////////////////////////////////////
// INPUT TYPES
/////////////////////////////////////////

export const UserWhereInputSchema: z.ZodType<Prisma.UserWhereInput> = z
  .object({
    AND: z
      .union([
        z.lazy(() => UserWhereInputSchema),
        z.lazy(() => UserWhereInputSchema).array(),
      ])
      .optional(),
    OR: z
      .lazy(() => UserWhereInputSchema)
      .array()
      .optional(),
    NOT: z
      .union([
        z.lazy(() => UserWhereInputSchema),
        z.lazy(() => UserWhereInputSchema).array(),
      ])
      .optional(),
    id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
    privyUserId: z
      .union([z.lazy(() => StringFilterSchema), z.string()])
      .optional(),
    createdAt: z
      .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
      .optional(),
    updatedAt: z
      .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
      .optional(),
    devices: z.lazy(() => DeviceListRelationFilterSchema).optional(),
    DeviceIdentity: z
      .lazy(() => DeviceIdentityListRelationFilterSchema)
      .optional(),
  })
  .strict();

export const UserOrderByWithRelationInputSchema: z.ZodType<Prisma.UserOrderByWithRelationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      privyUserId: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      devices: z
        .lazy(() => DeviceOrderByRelationAggregateInputSchema)
        .optional(),
      DeviceIdentity: z
        .lazy(() => DeviceIdentityOrderByRelationAggregateInputSchema)
        .optional(),
    })
    .strict();

export const UserWhereUniqueInputSchema: z.ZodType<Prisma.UserWhereUniqueInput> =
  z
    .union([
      z.object({
        id: z.string().uuid(),
        privyUserId: z.string(),
      }),
      z.object({
        id: z.string().uuid(),
      }),
      z.object({
        privyUserId: z.string(),
      }),
    ])
    .and(
      z
        .object({
          id: z.string().uuid().optional(),
          privyUserId: z.string().optional(),
          AND: z
            .union([
              z.lazy(() => UserWhereInputSchema),
              z.lazy(() => UserWhereInputSchema).array(),
            ])
            .optional(),
          OR: z
            .lazy(() => UserWhereInputSchema)
            .array()
            .optional(),
          NOT: z
            .union([
              z.lazy(() => UserWhereInputSchema),
              z.lazy(() => UserWhereInputSchema).array(),
            ])
            .optional(),
          createdAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          updatedAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          devices: z.lazy(() => DeviceListRelationFilterSchema).optional(),
          DeviceIdentity: z
            .lazy(() => DeviceIdentityListRelationFilterSchema)
            .optional(),
        })
        .strict(),
    );

export const UserOrderByWithAggregationInputSchema: z.ZodType<Prisma.UserOrderByWithAggregationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      privyUserId: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      _count: z.lazy(() => UserCountOrderByAggregateInputSchema).optional(),
      _max: z.lazy(() => UserMaxOrderByAggregateInputSchema).optional(),
      _min: z.lazy(() => UserMinOrderByAggregateInputSchema).optional(),
    })
    .strict();

export const UserScalarWhereWithAggregatesInputSchema: z.ZodType<Prisma.UserScalarWhereWithAggregatesInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => UserScalarWhereWithAggregatesInputSchema),
          z.lazy(() => UserScalarWhereWithAggregatesInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => UserScalarWhereWithAggregatesInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => UserScalarWhereWithAggregatesInputSchema),
          z.lazy(() => UserScalarWhereWithAggregatesInputSchema).array(),
        ])
        .optional(),
      id: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      privyUserId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      createdAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
    })
    .strict();

export const DeviceWhereInputSchema: z.ZodType<Prisma.DeviceWhereInput> = z
  .object({
    AND: z
      .union([
        z.lazy(() => DeviceWhereInputSchema),
        z.lazy(() => DeviceWhereInputSchema).array(),
      ])
      .optional(),
    OR: z
      .lazy(() => DeviceWhereInputSchema)
      .array()
      .optional(),
    NOT: z
      .union([
        z.lazy(() => DeviceWhereInputSchema),
        z.lazy(() => DeviceWhereInputSchema).array(),
      ])
      .optional(),
    id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
    userId: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
    name: z
      .union([z.lazy(() => StringNullableFilterSchema), z.string()])
      .optional()
      .nullable(),
    os: z
      .union([
        z.lazy(() => EnumDeviceOSFilterSchema),
        z.lazy(() => DeviceOSSchema),
      ])
      .optional(),
    pushToken: z
      .union([z.lazy(() => StringNullableFilterSchema), z.string()])
      .optional()
      .nullable(),
    expoToken: z
      .union([z.lazy(() => StringNullableFilterSchema), z.string()])
      .optional()
      .nullable(),
    createdAt: z
      .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
      .optional(),
    updatedAt: z
      .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
      .optional(),
    user: z
      .union([
        z.lazy(() => UserScalarRelationFilterSchema),
        z.lazy(() => UserWhereInputSchema),
      ])
      .optional(),
    identities: z
      .lazy(() => IdentitiesOnDeviceListRelationFilterSchema)
      .optional(),
  })
  .strict();

export const DeviceOrderByWithRelationInputSchema: z.ZodType<Prisma.DeviceOrderByWithRelationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      name: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      os: z.lazy(() => SortOrderSchema).optional(),
      pushToken: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      expoToken: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      user: z.lazy(() => UserOrderByWithRelationInputSchema).optional(),
      identities: z
        .lazy(() => IdentitiesOnDeviceOrderByRelationAggregateInputSchema)
        .optional(),
    })
    .strict();

export const DeviceWhereUniqueInputSchema: z.ZodType<Prisma.DeviceWhereUniqueInput> =
  z
    .object({
      id: z.string().uuid(),
    })
    .and(
      z
        .object({
          id: z.string().uuid().optional(),
          AND: z
            .union([
              z.lazy(() => DeviceWhereInputSchema),
              z.lazy(() => DeviceWhereInputSchema).array(),
            ])
            .optional(),
          OR: z
            .lazy(() => DeviceWhereInputSchema)
            .array()
            .optional(),
          NOT: z
            .union([
              z.lazy(() => DeviceWhereInputSchema),
              z.lazy(() => DeviceWhereInputSchema).array(),
            ])
            .optional(),
          userId: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          name: z
            .union([z.lazy(() => StringNullableFilterSchema), z.string()])
            .optional()
            .nullable(),
          os: z
            .union([
              z.lazy(() => EnumDeviceOSFilterSchema),
              z.lazy(() => DeviceOSSchema),
            ])
            .optional(),
          pushToken: z
            .union([z.lazy(() => StringNullableFilterSchema), z.string()])
            .optional()
            .nullable(),
          expoToken: z
            .union([z.lazy(() => StringNullableFilterSchema), z.string()])
            .optional()
            .nullable(),
          createdAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          updatedAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          user: z
            .union([
              z.lazy(() => UserScalarRelationFilterSchema),
              z.lazy(() => UserWhereInputSchema),
            ])
            .optional(),
          identities: z
            .lazy(() => IdentitiesOnDeviceListRelationFilterSchema)
            .optional(),
        })
        .strict(),
    );

export const DeviceOrderByWithAggregationInputSchema: z.ZodType<Prisma.DeviceOrderByWithAggregationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      name: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      os: z.lazy(() => SortOrderSchema).optional(),
      pushToken: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      expoToken: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      _count: z.lazy(() => DeviceCountOrderByAggregateInputSchema).optional(),
      _max: z.lazy(() => DeviceMaxOrderByAggregateInputSchema).optional(),
      _min: z.lazy(() => DeviceMinOrderByAggregateInputSchema).optional(),
    })
    .strict();

export const DeviceScalarWhereWithAggregatesInputSchema: z.ZodType<Prisma.DeviceScalarWhereWithAggregatesInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => DeviceScalarWhereWithAggregatesInputSchema),
          z.lazy(() => DeviceScalarWhereWithAggregatesInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => DeviceScalarWhereWithAggregatesInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => DeviceScalarWhereWithAggregatesInputSchema),
          z.lazy(() => DeviceScalarWhereWithAggregatesInputSchema).array(),
        ])
        .optional(),
      id: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      userId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      name: z
        .union([
          z.lazy(() => StringNullableWithAggregatesFilterSchema),
          z.string(),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => EnumDeviceOSWithAggregatesFilterSchema),
          z.lazy(() => DeviceOSSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.lazy(() => StringNullableWithAggregatesFilterSchema),
          z.string(),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.lazy(() => StringNullableWithAggregatesFilterSchema),
          z.string(),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityWhereInputSchema: z.ZodType<Prisma.DeviceIdentityWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => DeviceIdentityWhereInputSchema),
          z.lazy(() => DeviceIdentityWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => DeviceIdentityWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => DeviceIdentityWhereInputSchema),
          z.lazy(() => DeviceIdentityWhereInputSchema).array(),
        ])
        .optional(),
      id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
      userId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      xmtpId: z
        .union([z.lazy(() => StringNullableFilterSchema), z.string()])
        .optional()
        .nullable(),
      privyAddress: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      createdAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      updatedAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      profile: z
        .union([
          z.lazy(() => ProfileNullableScalarRelationFilterSchema),
          z.lazy(() => ProfileWhereInputSchema),
        ])
        .optional()
        .nullable(),
      conversationMetadata: z
        .lazy(() => ConversationMetadataListRelationFilterSchema)
        .optional(),
      devices: z
        .lazy(() => IdentitiesOnDeviceListRelationFilterSchema)
        .optional(),
      user: z
        .union([
          z.lazy(() => UserScalarRelationFilterSchema),
          z.lazy(() => UserWhereInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityOrderByWithRelationInputSchema: z.ZodType<Prisma.DeviceIdentityOrderByWithRelationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      xmtpId: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      privyAddress: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      profile: z.lazy(() => ProfileOrderByWithRelationInputSchema).optional(),
      conversationMetadata: z
        .lazy(() => ConversationMetadataOrderByRelationAggregateInputSchema)
        .optional(),
      devices: z
        .lazy(() => IdentitiesOnDeviceOrderByRelationAggregateInputSchema)
        .optional(),
      user: z.lazy(() => UserOrderByWithRelationInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityWhereUniqueInputSchema: z.ZodType<Prisma.DeviceIdentityWhereUniqueInput> =
  z
    .object({
      id: z.string().uuid(),
    })
    .and(
      z
        .object({
          id: z.string().uuid().optional(),
          AND: z
            .union([
              z.lazy(() => DeviceIdentityWhereInputSchema),
              z.lazy(() => DeviceIdentityWhereInputSchema).array(),
            ])
            .optional(),
          OR: z
            .lazy(() => DeviceIdentityWhereInputSchema)
            .array()
            .optional(),
          NOT: z
            .union([
              z.lazy(() => DeviceIdentityWhereInputSchema),
              z.lazy(() => DeviceIdentityWhereInputSchema).array(),
            ])
            .optional(),
          userId: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          xmtpId: z
            .union([z.lazy(() => StringNullableFilterSchema), z.string()])
            .optional()
            .nullable(),
          privyAddress: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          createdAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          updatedAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          profile: z
            .union([
              z.lazy(() => ProfileNullableScalarRelationFilterSchema),
              z.lazy(() => ProfileWhereInputSchema),
            ])
            .optional()
            .nullable(),
          conversationMetadata: z
            .lazy(() => ConversationMetadataListRelationFilterSchema)
            .optional(),
          devices: z
            .lazy(() => IdentitiesOnDeviceListRelationFilterSchema)
            .optional(),
          user: z
            .union([
              z.lazy(() => UserScalarRelationFilterSchema),
              z.lazy(() => UserWhereInputSchema),
            ])
            .optional(),
        })
        .strict(),
    );

export const DeviceIdentityOrderByWithAggregationInputSchema: z.ZodType<Prisma.DeviceIdentityOrderByWithAggregationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      xmtpId: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      privyAddress: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      _count: z
        .lazy(() => DeviceIdentityCountOrderByAggregateInputSchema)
        .optional(),
      _max: z
        .lazy(() => DeviceIdentityMaxOrderByAggregateInputSchema)
        .optional(),
      _min: z
        .lazy(() => DeviceIdentityMinOrderByAggregateInputSchema)
        .optional(),
    })
    .strict();

export const DeviceIdentityScalarWhereWithAggregatesInputSchema: z.ZodType<Prisma.DeviceIdentityScalarWhereWithAggregatesInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => DeviceIdentityScalarWhereWithAggregatesInputSchema),
          z
            .lazy(() => DeviceIdentityScalarWhereWithAggregatesInputSchema)
            .array(),
        ])
        .optional(),
      OR: z
        .lazy(() => DeviceIdentityScalarWhereWithAggregatesInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => DeviceIdentityScalarWhereWithAggregatesInputSchema),
          z
            .lazy(() => DeviceIdentityScalarWhereWithAggregatesInputSchema)
            .array(),
        ])
        .optional(),
      id: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      userId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      xmtpId: z
        .union([
          z.lazy(() => StringNullableWithAggregatesFilterSchema),
          z.string(),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      createdAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceWhereInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => IdentitiesOnDeviceWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereInputSchema).array(),
        ])
        .optional(),
      deviceId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      identityId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      device: z
        .union([
          z.lazy(() => DeviceScalarRelationFilterSchema),
          z.lazy(() => DeviceWhereInputSchema),
        ])
        .optional(),
      identity: z
        .union([
          z.lazy(() => DeviceIdentityScalarRelationFilterSchema),
          z.lazy(() => DeviceIdentityWhereInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceOrderByWithRelationInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceOrderByWithRelationInput> =
  z
    .object({
      deviceId: z.lazy(() => SortOrderSchema).optional(),
      identityId: z.lazy(() => SortOrderSchema).optional(),
      device: z.lazy(() => DeviceOrderByWithRelationInputSchema).optional(),
      identity: z
        .lazy(() => DeviceIdentityOrderByWithRelationInputSchema)
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceWhereUniqueInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceWhereUniqueInput> =
  z
    .object({
      deviceId_identityId: z.lazy(
        () => IdentitiesOnDeviceDeviceIdIdentityIdCompoundUniqueInputSchema,
      ),
    })
    .and(
      z
        .object({
          deviceId_identityId: z
            .lazy(
              () =>
                IdentitiesOnDeviceDeviceIdIdentityIdCompoundUniqueInputSchema,
            )
            .optional(),
          AND: z
            .union([
              z.lazy(() => IdentitiesOnDeviceWhereInputSchema),
              z.lazy(() => IdentitiesOnDeviceWhereInputSchema).array(),
            ])
            .optional(),
          OR: z
            .lazy(() => IdentitiesOnDeviceWhereInputSchema)
            .array()
            .optional(),
          NOT: z
            .union([
              z.lazy(() => IdentitiesOnDeviceWhereInputSchema),
              z.lazy(() => IdentitiesOnDeviceWhereInputSchema).array(),
            ])
            .optional(),
          deviceId: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          identityId: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          device: z
            .union([
              z.lazy(() => DeviceScalarRelationFilterSchema),
              z.lazy(() => DeviceWhereInputSchema),
            ])
            .optional(),
          identity: z
            .union([
              z.lazy(() => DeviceIdentityScalarRelationFilterSchema),
              z.lazy(() => DeviceIdentityWhereInputSchema),
            ])
            .optional(),
        })
        .strict(),
    );

export const IdentitiesOnDeviceOrderByWithAggregationInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceOrderByWithAggregationInput> =
  z
    .object({
      deviceId: z.lazy(() => SortOrderSchema).optional(),
      identityId: z.lazy(() => SortOrderSchema).optional(),
      _count: z
        .lazy(() => IdentitiesOnDeviceCountOrderByAggregateInputSchema)
        .optional(),
      _max: z
        .lazy(() => IdentitiesOnDeviceMaxOrderByAggregateInputSchema)
        .optional(),
      _min: z
        .lazy(() => IdentitiesOnDeviceMinOrderByAggregateInputSchema)
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceScalarWhereWithAggregatesInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema)
            .array(),
        ])
        .optional(),
      OR: z
        .lazy(() => IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema)
            .array(),
        ])
        .optional(),
      deviceId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      identityId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
    })
    .strict();

export const ProfileWhereInputSchema: z.ZodType<Prisma.ProfileWhereInput> = z
  .object({
    AND: z
      .union([
        z.lazy(() => ProfileWhereInputSchema),
        z.lazy(() => ProfileWhereInputSchema).array(),
      ])
      .optional(),
    OR: z
      .lazy(() => ProfileWhereInputSchema)
      .array()
      .optional(),
    NOT: z
      .union([
        z.lazy(() => ProfileWhereInputSchema),
        z.lazy(() => ProfileWhereInputSchema).array(),
      ])
      .optional(),
    id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
    deviceIdentityId: z
      .union([z.lazy(() => StringFilterSchema), z.string()])
      .optional(),
    name: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
    username: z
      .union([z.lazy(() => StringFilterSchema), z.string()])
      .optional(),
    description: z
      .union([z.lazy(() => StringNullableFilterSchema), z.string()])
      .optional()
      .nullable(),
    avatar: z
      .union([z.lazy(() => StringNullableFilterSchema), z.string()])
      .optional()
      .nullable(),
    createdAt: z
      .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
      .optional(),
    updatedAt: z
      .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
      .optional(),
    deviceIdentity: z
      .union([
        z.lazy(() => DeviceIdentityScalarRelationFilterSchema),
        z.lazy(() => DeviceIdentityWhereInputSchema),
      ])
      .optional(),
  })
  .strict();

export const ProfileOrderByWithRelationInputSchema: z.ZodType<Prisma.ProfileOrderByWithRelationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      username: z.lazy(() => SortOrderSchema).optional(),
      description: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      avatar: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentity: z
        .lazy(() => DeviceIdentityOrderByWithRelationInputSchema)
        .optional(),
    })
    .strict();

export const ProfileWhereUniqueInputSchema: z.ZodType<Prisma.ProfileWhereUniqueInput> =
  z
    .union([
      z.object({
        id: z.string().uuid(),
        deviceIdentityId: z.string(),
        username: z.string(),
      }),
      z.object({
        id: z.string().uuid(),
        deviceIdentityId: z.string(),
      }),
      z.object({
        id: z.string().uuid(),
        username: z.string(),
      }),
      z.object({
        id: z.string().uuid(),
      }),
      z.object({
        deviceIdentityId: z.string(),
        username: z.string(),
      }),
      z.object({
        deviceIdentityId: z.string(),
      }),
      z.object({
        username: z.string(),
      }),
    ])
    .and(
      z
        .object({
          id: z.string().uuid().optional(),
          deviceIdentityId: z.string().optional(),
          username: z.string().optional(),
          AND: z
            .union([
              z.lazy(() => ProfileWhereInputSchema),
              z.lazy(() => ProfileWhereInputSchema).array(),
            ])
            .optional(),
          OR: z
            .lazy(() => ProfileWhereInputSchema)
            .array()
            .optional(),
          NOT: z
            .union([
              z.lazy(() => ProfileWhereInputSchema),
              z.lazy(() => ProfileWhereInputSchema).array(),
            ])
            .optional(),
          name: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          description: z
            .union([z.lazy(() => StringNullableFilterSchema), z.string()])
            .optional()
            .nullable(),
          avatar: z
            .union([z.lazy(() => StringNullableFilterSchema), z.string()])
            .optional()
            .nullable(),
          createdAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          updatedAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          deviceIdentity: z
            .union([
              z.lazy(() => DeviceIdentityScalarRelationFilterSchema),
              z.lazy(() => DeviceIdentityWhereInputSchema),
            ])
            .optional(),
        })
        .strict(),
    );

export const ProfileOrderByWithAggregationInputSchema: z.ZodType<Prisma.ProfileOrderByWithAggregationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      username: z.lazy(() => SortOrderSchema).optional(),
      description: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      avatar: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      _count: z.lazy(() => ProfileCountOrderByAggregateInputSchema).optional(),
      _max: z.lazy(() => ProfileMaxOrderByAggregateInputSchema).optional(),
      _min: z.lazy(() => ProfileMinOrderByAggregateInputSchema).optional(),
    })
    .strict();

export const ProfileScalarWhereWithAggregatesInputSchema: z.ZodType<Prisma.ProfileScalarWhereWithAggregatesInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => ProfileScalarWhereWithAggregatesInputSchema),
          z.lazy(() => ProfileScalarWhereWithAggregatesInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => ProfileScalarWhereWithAggregatesInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => ProfileScalarWhereWithAggregatesInputSchema),
          z.lazy(() => ProfileScalarWhereWithAggregatesInputSchema).array(),
        ])
        .optional(),
      id: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      deviceIdentityId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      name: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      username: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      description: z
        .union([
          z.lazy(() => StringNullableWithAggregatesFilterSchema),
          z.string(),
        ])
        .optional()
        .nullable(),
      avatar: z
        .union([
          z.lazy(() => StringNullableWithAggregatesFilterSchema),
          z.string(),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataWhereInputSchema: z.ZodType<Prisma.ConversationMetadataWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => ConversationMetadataWhereInputSchema),
          z.lazy(() => ConversationMetadataWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => ConversationMetadataWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => ConversationMetadataWhereInputSchema),
          z.lazy(() => ConversationMetadataWhereInputSchema).array(),
        ])
        .optional(),
      id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
      deviceIdentityId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      conversationId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      pinned: z.union([z.lazy(() => BoolFilterSchema), z.boolean()]).optional(),
      unread: z.union([z.lazy(() => BoolFilterSchema), z.boolean()]).optional(),
      deleted: z
        .union([z.lazy(() => BoolFilterSchema), z.boolean()])
        .optional(),
      readUntil: z
        .union([z.lazy(() => DateTimeNullableFilterSchema), z.coerce.date()])
        .optional()
        .nullable(),
      createdAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      updatedAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      deviceIdentity: z
        .union([
          z.lazy(() => DeviceIdentityScalarRelationFilterSchema),
          z.lazy(() => DeviceIdentityWhereInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataOrderByWithRelationInputSchema: z.ZodType<Prisma.ConversationMetadataOrderByWithRelationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      conversationId: z.lazy(() => SortOrderSchema).optional(),
      pinned: z.lazy(() => SortOrderSchema).optional(),
      unread: z.lazy(() => SortOrderSchema).optional(),
      deleted: z.lazy(() => SortOrderSchema).optional(),
      readUntil: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentity: z
        .lazy(() => DeviceIdentityOrderByWithRelationInputSchema)
        .optional(),
    })
    .strict();

export const ConversationMetadataWhereUniqueInputSchema: z.ZodType<Prisma.ConversationMetadataWhereUniqueInput> =
  z
    .union([
      z.object({
        id: z.string().uuid(),
        deviceIdentityId_conversationId: z.lazy(
          () =>
            ConversationMetadataDeviceIdentityIdConversationIdCompoundUniqueInputSchema,
        ),
      }),
      z.object({
        id: z.string().uuid(),
      }),
      z.object({
        deviceIdentityId_conversationId: z.lazy(
          () =>
            ConversationMetadataDeviceIdentityIdConversationIdCompoundUniqueInputSchema,
        ),
      }),
    ])
    .and(
      z
        .object({
          id: z.string().uuid().optional(),
          deviceIdentityId_conversationId: z
            .lazy(
              () =>
                ConversationMetadataDeviceIdentityIdConversationIdCompoundUniqueInputSchema,
            )
            .optional(),
          AND: z
            .union([
              z.lazy(() => ConversationMetadataWhereInputSchema),
              z.lazy(() => ConversationMetadataWhereInputSchema).array(),
            ])
            .optional(),
          OR: z
            .lazy(() => ConversationMetadataWhereInputSchema)
            .array()
            .optional(),
          NOT: z
            .union([
              z.lazy(() => ConversationMetadataWhereInputSchema),
              z.lazy(() => ConversationMetadataWhereInputSchema).array(),
            ])
            .optional(),
          deviceIdentityId: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          conversationId: z
            .union([z.lazy(() => StringFilterSchema), z.string()])
            .optional(),
          pinned: z
            .union([z.lazy(() => BoolFilterSchema), z.boolean()])
            .optional(),
          unread: z
            .union([z.lazy(() => BoolFilterSchema), z.boolean()])
            .optional(),
          deleted: z
            .union([z.lazy(() => BoolFilterSchema), z.boolean()])
            .optional(),
          readUntil: z
            .union([
              z.lazy(() => DateTimeNullableFilterSchema),
              z.coerce.date(),
            ])
            .optional()
            .nullable(),
          createdAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          updatedAt: z
            .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
            .optional(),
          deviceIdentity: z
            .union([
              z.lazy(() => DeviceIdentityScalarRelationFilterSchema),
              z.lazy(() => DeviceIdentityWhereInputSchema),
            ])
            .optional(),
        })
        .strict(),
    );

export const ConversationMetadataOrderByWithAggregationInputSchema: z.ZodType<Prisma.ConversationMetadataOrderByWithAggregationInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      conversationId: z.lazy(() => SortOrderSchema).optional(),
      pinned: z.lazy(() => SortOrderSchema).optional(),
      unread: z.lazy(() => SortOrderSchema).optional(),
      deleted: z.lazy(() => SortOrderSchema).optional(),
      readUntil: z
        .union([
          z.lazy(() => SortOrderSchema),
          z.lazy(() => SortOrderInputSchema),
        ])
        .optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
      _count: z
        .lazy(() => ConversationMetadataCountOrderByAggregateInputSchema)
        .optional(),
      _max: z
        .lazy(() => ConversationMetadataMaxOrderByAggregateInputSchema)
        .optional(),
      _min: z
        .lazy(() => ConversationMetadataMinOrderByAggregateInputSchema)
        .optional(),
    })
    .strict();

export const ConversationMetadataScalarWhereWithAggregatesInputSchema: z.ZodType<Prisma.ConversationMetadataScalarWhereWithAggregatesInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(
            () => ConversationMetadataScalarWhereWithAggregatesInputSchema,
          ),
          z
            .lazy(
              () => ConversationMetadataScalarWhereWithAggregatesInputSchema,
            )
            .array(),
        ])
        .optional(),
      OR: z
        .lazy(() => ConversationMetadataScalarWhereWithAggregatesInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(
            () => ConversationMetadataScalarWhereWithAggregatesInputSchema,
          ),
          z
            .lazy(
              () => ConversationMetadataScalarWhereWithAggregatesInputSchema,
            )
            .array(),
        ])
        .optional(),
      id: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      deviceIdentityId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      conversationId: z
        .union([z.lazy(() => StringWithAggregatesFilterSchema), z.string()])
        .optional(),
      pinned: z
        .union([z.lazy(() => BoolWithAggregatesFilterSchema), z.boolean()])
        .optional(),
      unread: z
        .union([z.lazy(() => BoolWithAggregatesFilterSchema), z.boolean()])
        .optional(),
      deleted: z
        .union([z.lazy(() => BoolWithAggregatesFilterSchema), z.boolean()])
        .optional(),
      readUntil: z
        .union([
          z.lazy(() => DateTimeNullableWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.lazy(() => DateTimeWithAggregatesFilterSchema),
          z.coerce.date(),
        ])
        .optional(),
    })
    .strict();

export const UserCreateInputSchema: z.ZodType<Prisma.UserCreateInput> = z
  .object({
    id: z.string().uuid().optional(),
    privyUserId: z.string(),
    createdAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
    devices: z
      .lazy(() => DeviceCreateNestedManyWithoutUserInputSchema)
      .optional(),
    DeviceIdentity: z
      .lazy(() => DeviceIdentityCreateNestedManyWithoutUserInputSchema)
      .optional(),
  })
  .strict();

export const UserUncheckedCreateInputSchema: z.ZodType<Prisma.UserUncheckedCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      privyUserId: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      devices: z
        .lazy(() => DeviceUncheckedCreateNestedManyWithoutUserInputSchema)
        .optional(),
      DeviceIdentity: z
        .lazy(
          () => DeviceIdentityUncheckedCreateNestedManyWithoutUserInputSchema,
        )
        .optional(),
    })
    .strict();

export const UserUpdateInputSchema: z.ZodType<Prisma.UserUpdateInput> = z
  .object({
    id: z
      .union([
        z.string().uuid(),
        z.lazy(() => StringFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    privyUserId: z
      .union([z.string(), z.lazy(() => StringFieldUpdateOperationsInputSchema)])
      .optional(),
    createdAt: z
      .union([
        z.coerce.date(),
        z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    updatedAt: z
      .union([
        z.coerce.date(),
        z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    devices: z
      .lazy(() => DeviceUpdateManyWithoutUserNestedInputSchema)
      .optional(),
    DeviceIdentity: z
      .lazy(() => DeviceIdentityUpdateManyWithoutUserNestedInputSchema)
      .optional(),
  })
  .strict();

export const UserUncheckedUpdateInputSchema: z.ZodType<Prisma.UserUncheckedUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      devices: z
        .lazy(() => DeviceUncheckedUpdateManyWithoutUserNestedInputSchema)
        .optional(),
      DeviceIdentity: z
        .lazy(
          () => DeviceIdentityUncheckedUpdateManyWithoutUserNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const UserCreateManyInputSchema: z.ZodType<Prisma.UserCreateManyInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      privyUserId: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const UserUpdateManyMutationInputSchema: z.ZodType<Prisma.UserUpdateManyMutationInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const UserUncheckedUpdateManyInputSchema: z.ZodType<Prisma.UserUncheckedUpdateManyInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceCreateInputSchema: z.ZodType<Prisma.DeviceCreateInput> = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().optional().nullable(),
    os: z.lazy(() => DeviceOSSchema),
    pushToken: z.string().optional().nullable(),
    expoToken: z.string().optional().nullable(),
    createdAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
    user: z.lazy(() => UserCreateNestedOneWithoutDevicesInputSchema),
    identities: z
      .lazy(() => IdentitiesOnDeviceCreateNestedManyWithoutDeviceInputSchema)
      .optional(),
  })
  .strict();

export const DeviceUncheckedCreateInputSchema: z.ZodType<Prisma.DeviceUncheckedCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      identities: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedCreateNestedManyWithoutDeviceInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceUpdateInputSchema: z.ZodType<Prisma.DeviceUpdateInput> = z
  .object({
    id: z
      .union([
        z.string().uuid(),
        z.lazy(() => StringFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    name: z
      .union([
        z.string(),
        z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
      ])
      .optional()
      .nullable(),
    os: z
      .union([
        z.lazy(() => DeviceOSSchema),
        z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    pushToken: z
      .union([
        z.string(),
        z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
      ])
      .optional()
      .nullable(),
    expoToken: z
      .union([
        z.string(),
        z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
      ])
      .optional()
      .nullable(),
    createdAt: z
      .union([
        z.coerce.date(),
        z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    updatedAt: z
      .union([
        z.coerce.date(),
        z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    user: z
      .lazy(() => UserUpdateOneRequiredWithoutDevicesNestedInputSchema)
      .optional(),
    identities: z
      .lazy(() => IdentitiesOnDeviceUpdateManyWithoutDeviceNestedInputSchema)
      .optional(),
  })
  .strict();

export const DeviceUncheckedUpdateInputSchema: z.ZodType<Prisma.DeviceUncheckedUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      identities: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceCreateManyInputSchema: z.ZodType<Prisma.DeviceCreateManyInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const DeviceUpdateManyMutationInputSchema: z.ZodType<Prisma.DeviceUpdateManyMutationInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceUncheckedUpdateManyInputSchema: z.ZodType<Prisma.DeviceUncheckedUpdateManyInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateInputSchema: z.ZodType<Prisma.DeviceIdentityCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(() => ProfileCreateNestedOneWithoutDeviceIdentityInputSchema)
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
      user: z.lazy(() => UserCreateNestedOneWithoutDeviceIdentityInputSchema),
    })
    .strict();

export const DeviceIdentityUncheckedCreateInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedCreateNestedOneWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityUpdateInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(() => ProfileUpdateOneWithoutDeviceIdentityNestedInputSchema)
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
      user: z
        .lazy(() => UserUpdateOneRequiredWithoutDeviceIdentityNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedUpdateOneWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateManyInputSchema: z.ZodType<Prisma.DeviceIdentityCreateManyInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const DeviceIdentityUpdateManyMutationInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateManyMutationInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateManyInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateManyInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateInput> =
  z
    .object({
      device: z.lazy(() => DeviceCreateNestedOneWithoutIdentitiesInputSchema),
      identity: z.lazy(
        () => DeviceIdentityCreateNestedOneWithoutDevicesInputSchema,
      ),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedCreateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedCreateInput> =
  z
    .object({
      deviceId: z.string(),
      identityId: z.string(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateInput> =
  z
    .object({
      device: z
        .lazy(() => DeviceUpdateOneRequiredWithoutIdentitiesNestedInputSchema)
        .optional(),
      identity: z
        .lazy(
          () => DeviceIdentityUpdateOneRequiredWithoutDevicesNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateInput> =
  z
    .object({
      deviceId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      identityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyInput> =
  z
    .object({
      deviceId: z.string(),
      identityId: z.string(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyMutationInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyMutationInput> =
  z.object({}).strict();

export const IdentitiesOnDeviceUncheckedUpdateManyInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateManyInput> =
  z
    .object({
      deviceId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      identityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ProfileCreateInputSchema: z.ZodType<Prisma.ProfileCreateInput> = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string(),
    username: z.string(),
    description: z.string().optional().nullable(),
    avatar: z.string().optional().nullable(),
    createdAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
    deviceIdentity: z.lazy(
      () => DeviceIdentityCreateNestedOneWithoutProfileInputSchema,
    ),
  })
  .strict();

export const ProfileUncheckedCreateInputSchema: z.ZodType<Prisma.ProfileUncheckedCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      deviceIdentityId: z.string(),
      name: z.string(),
      username: z.string(),
      description: z.string().optional().nullable(),
      avatar: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ProfileUpdateInputSchema: z.ZodType<Prisma.ProfileUpdateInput> = z
  .object({
    id: z
      .union([
        z.string().uuid(),
        z.lazy(() => StringFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    name: z
      .union([z.string(), z.lazy(() => StringFieldUpdateOperationsInputSchema)])
      .optional(),
    username: z
      .union([z.string(), z.lazy(() => StringFieldUpdateOperationsInputSchema)])
      .optional(),
    description: z
      .union([
        z.string(),
        z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
      ])
      .optional()
      .nullable(),
    avatar: z
      .union([
        z.string(),
        z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
      ])
      .optional()
      .nullable(),
    createdAt: z
      .union([
        z.coerce.date(),
        z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    updatedAt: z
      .union([
        z.coerce.date(),
        z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
      ])
      .optional(),
    deviceIdentity: z
      .lazy(
        () => DeviceIdentityUpdateOneRequiredWithoutProfileNestedInputSchema,
      )
      .optional(),
  })
  .strict();

export const ProfileUncheckedUpdateInputSchema: z.ZodType<Prisma.ProfileUncheckedUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deviceIdentityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      username: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      description: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      avatar: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ProfileCreateManyInputSchema: z.ZodType<Prisma.ProfileCreateManyInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      deviceIdentityId: z.string(),
      name: z.string(),
      username: z.string(),
      description: z.string().optional().nullable(),
      avatar: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ProfileUpdateManyMutationInputSchema: z.ZodType<Prisma.ProfileUpdateManyMutationInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      username: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      description: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      avatar: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ProfileUncheckedUpdateManyInputSchema: z.ZodType<Prisma.ProfileUncheckedUpdateManyInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deviceIdentityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      username: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      description: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      avatar: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataCreateInputSchema: z.ZodType<Prisma.ConversationMetadataCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      conversationId: z.string(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.coerce.date().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      deviceIdentity: z.lazy(
        () =>
          DeviceIdentityCreateNestedOneWithoutConversationMetadataInputSchema,
      ),
    })
    .strict();

export const ConversationMetadataUncheckedCreateInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedCreateInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      deviceIdentityId: z.string(),
      conversationId: z.string(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.coerce.date().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ConversationMetadataUpdateInputSchema: z.ZodType<Prisma.ConversationMetadataUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deviceIdentity: z
        .lazy(
          () =>
            DeviceIdentityUpdateOneRequiredWithoutConversationMetadataNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const ConversationMetadataUncheckedUpdateInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedUpdateInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deviceIdentityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataCreateManyInputSchema: z.ZodType<Prisma.ConversationMetadataCreateManyInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      deviceIdentityId: z.string(),
      conversationId: z.string(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.coerce.date().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ConversationMetadataUpdateManyMutationInputSchema: z.ZodType<Prisma.ConversationMetadataUpdateManyMutationInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataUncheckedUpdateManyInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedUpdateManyInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deviceIdentityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const StringFilterSchema: z.ZodType<Prisma.StringFilter> = z
  .object({
    equals: z.string().optional(),
    in: z.string().array().optional(),
    notIn: z.string().array().optional(),
    lt: z.string().optional(),
    lte: z.string().optional(),
    gt: z.string().optional(),
    gte: z.string().optional(),
    contains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    mode: z.lazy(() => QueryModeSchema).optional(),
    not: z
      .union([z.string(), z.lazy(() => NestedStringFilterSchema)])
      .optional(),
  })
  .strict();

export const DateTimeFilterSchema: z.ZodType<Prisma.DateTimeFilter> = z
  .object({
    equals: z.coerce.date().optional(),
    in: z.coerce.date().array().optional(),
    notIn: z.coerce.date().array().optional(),
    lt: z.coerce.date().optional(),
    lte: z.coerce.date().optional(),
    gt: z.coerce.date().optional(),
    gte: z.coerce.date().optional(),
    not: z
      .union([z.coerce.date(), z.lazy(() => NestedDateTimeFilterSchema)])
      .optional(),
  })
  .strict();

export const DeviceListRelationFilterSchema: z.ZodType<Prisma.DeviceListRelationFilter> =
  z
    .object({
      every: z.lazy(() => DeviceWhereInputSchema).optional(),
      some: z.lazy(() => DeviceWhereInputSchema).optional(),
      none: z.lazy(() => DeviceWhereInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityListRelationFilterSchema: z.ZodType<Prisma.DeviceIdentityListRelationFilter> =
  z
    .object({
      every: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
      some: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
      none: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
    })
    .strict();

export const DeviceOrderByRelationAggregateInputSchema: z.ZodType<Prisma.DeviceOrderByRelationAggregateInput> =
  z
    .object({
      _count: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceIdentityOrderByRelationAggregateInputSchema: z.ZodType<Prisma.DeviceIdentityOrderByRelationAggregateInput> =
  z
    .object({
      _count: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const UserCountOrderByAggregateInputSchema: z.ZodType<Prisma.UserCountOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      privyUserId: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const UserMaxOrderByAggregateInputSchema: z.ZodType<Prisma.UserMaxOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      privyUserId: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const UserMinOrderByAggregateInputSchema: z.ZodType<Prisma.UserMinOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      privyUserId: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const StringWithAggregatesFilterSchema: z.ZodType<Prisma.StringWithAggregatesFilter> =
  z
    .object({
      equals: z.string().optional(),
      in: z.string().array().optional(),
      notIn: z.string().array().optional(),
      lt: z.string().optional(),
      lte: z.string().optional(),
      gt: z.string().optional(),
      gte: z.string().optional(),
      contains: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      mode: z.lazy(() => QueryModeSchema).optional(),
      not: z
        .union([
          z.string(),
          z.lazy(() => NestedStringWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedStringFilterSchema).optional(),
      _max: z.lazy(() => NestedStringFilterSchema).optional(),
    })
    .strict();

export const DateTimeWithAggregatesFilterSchema: z.ZodType<Prisma.DateTimeWithAggregatesFilter> =
  z
    .object({
      equals: z.coerce.date().optional(),
      in: z.coerce.date().array().optional(),
      notIn: z.coerce.date().array().optional(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([
          z.coerce.date(),
          z.lazy(() => NestedDateTimeWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedDateTimeFilterSchema).optional(),
      _max: z.lazy(() => NestedDateTimeFilterSchema).optional(),
    })
    .strict();

export const StringNullableFilterSchema: z.ZodType<Prisma.StringNullableFilter> =
  z
    .object({
      equals: z.string().optional().nullable(),
      in: z.string().array().optional().nullable(),
      notIn: z.string().array().optional().nullable(),
      lt: z.string().optional(),
      lte: z.string().optional(),
      gt: z.string().optional(),
      gte: z.string().optional(),
      contains: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      mode: z.lazy(() => QueryModeSchema).optional(),
      not: z
        .union([z.string(), z.lazy(() => NestedStringNullableFilterSchema)])
        .optional()
        .nullable(),
    })
    .strict();

export const EnumDeviceOSFilterSchema: z.ZodType<Prisma.EnumDeviceOSFilter> = z
  .object({
    equals: z.lazy(() => DeviceOSSchema).optional(),
    in: z
      .lazy(() => DeviceOSSchema)
      .array()
      .optional(),
    notIn: z
      .lazy(() => DeviceOSSchema)
      .array()
      .optional(),
    not: z
      .union([
        z.lazy(() => DeviceOSSchema),
        z.lazy(() => NestedEnumDeviceOSFilterSchema),
      ])
      .optional(),
  })
  .strict();

export const UserScalarRelationFilterSchema: z.ZodType<Prisma.UserScalarRelationFilter> =
  z
    .object({
      is: z.lazy(() => UserWhereInputSchema).optional(),
      isNot: z.lazy(() => UserWhereInputSchema).optional(),
    })
    .strict();

export const IdentitiesOnDeviceListRelationFilterSchema: z.ZodType<Prisma.IdentitiesOnDeviceListRelationFilter> =
  z
    .object({
      every: z.lazy(() => IdentitiesOnDeviceWhereInputSchema).optional(),
      some: z.lazy(() => IdentitiesOnDeviceWhereInputSchema).optional(),
      none: z.lazy(() => IdentitiesOnDeviceWhereInputSchema).optional(),
    })
    .strict();

export const SortOrderInputSchema: z.ZodType<Prisma.SortOrderInput> = z
  .object({
    sort: z.lazy(() => SortOrderSchema),
    nulls: z.lazy(() => NullsOrderSchema).optional(),
  })
  .strict();

export const IdentitiesOnDeviceOrderByRelationAggregateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceOrderByRelationAggregateInput> =
  z
    .object({
      _count: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceCountOrderByAggregateInputSchema: z.ZodType<Prisma.DeviceCountOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      os: z.lazy(() => SortOrderSchema).optional(),
      pushToken: z.lazy(() => SortOrderSchema).optional(),
      expoToken: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceMaxOrderByAggregateInputSchema: z.ZodType<Prisma.DeviceMaxOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      os: z.lazy(() => SortOrderSchema).optional(),
      pushToken: z.lazy(() => SortOrderSchema).optional(),
      expoToken: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceMinOrderByAggregateInputSchema: z.ZodType<Prisma.DeviceMinOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      os: z.lazy(() => SortOrderSchema).optional(),
      pushToken: z.lazy(() => SortOrderSchema).optional(),
      expoToken: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const StringNullableWithAggregatesFilterSchema: z.ZodType<Prisma.StringNullableWithAggregatesFilter> =
  z
    .object({
      equals: z.string().optional().nullable(),
      in: z.string().array().optional().nullable(),
      notIn: z.string().array().optional().nullable(),
      lt: z.string().optional(),
      lte: z.string().optional(),
      gt: z.string().optional(),
      gte: z.string().optional(),
      contains: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      mode: z.lazy(() => QueryModeSchema).optional(),
      not: z
        .union([
          z.string(),
          z.lazy(() => NestedStringNullableWithAggregatesFilterSchema),
        ])
        .optional()
        .nullable(),
      _count: z.lazy(() => NestedIntNullableFilterSchema).optional(),
      _min: z.lazy(() => NestedStringNullableFilterSchema).optional(),
      _max: z.lazy(() => NestedStringNullableFilterSchema).optional(),
    })
    .strict();

export const EnumDeviceOSWithAggregatesFilterSchema: z.ZodType<Prisma.EnumDeviceOSWithAggregatesFilter> =
  z
    .object({
      equals: z.lazy(() => DeviceOSSchema).optional(),
      in: z
        .lazy(() => DeviceOSSchema)
        .array()
        .optional(),
      notIn: z
        .lazy(() => DeviceOSSchema)
        .array()
        .optional(),
      not: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => NestedEnumDeviceOSWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedEnumDeviceOSFilterSchema).optional(),
      _max: z.lazy(() => NestedEnumDeviceOSFilterSchema).optional(),
    })
    .strict();

export const ProfileNullableScalarRelationFilterSchema: z.ZodType<Prisma.ProfileNullableScalarRelationFilter> =
  z
    .object({
      is: z
        .lazy(() => ProfileWhereInputSchema)
        .optional()
        .nullable(),
      isNot: z
        .lazy(() => ProfileWhereInputSchema)
        .optional()
        .nullable(),
    })
    .strict();

export const ConversationMetadataListRelationFilterSchema: z.ZodType<Prisma.ConversationMetadataListRelationFilter> =
  z
    .object({
      every: z.lazy(() => ConversationMetadataWhereInputSchema).optional(),
      some: z.lazy(() => ConversationMetadataWhereInputSchema).optional(),
      none: z.lazy(() => ConversationMetadataWhereInputSchema).optional(),
    })
    .strict();

export const ConversationMetadataOrderByRelationAggregateInputSchema: z.ZodType<Prisma.ConversationMetadataOrderByRelationAggregateInput> =
  z
    .object({
      _count: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceIdentityCountOrderByAggregateInputSchema: z.ZodType<Prisma.DeviceIdentityCountOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      xmtpId: z.lazy(() => SortOrderSchema).optional(),
      privyAddress: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceIdentityMaxOrderByAggregateInputSchema: z.ZodType<Prisma.DeviceIdentityMaxOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      xmtpId: z.lazy(() => SortOrderSchema).optional(),
      privyAddress: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceIdentityMinOrderByAggregateInputSchema: z.ZodType<Prisma.DeviceIdentityMinOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      userId: z.lazy(() => SortOrderSchema).optional(),
      xmtpId: z.lazy(() => SortOrderSchema).optional(),
      privyAddress: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const DeviceScalarRelationFilterSchema: z.ZodType<Prisma.DeviceScalarRelationFilter> =
  z
    .object({
      is: z.lazy(() => DeviceWhereInputSchema).optional(),
      isNot: z.lazy(() => DeviceWhereInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityScalarRelationFilterSchema: z.ZodType<Prisma.DeviceIdentityScalarRelationFilter> =
  z
    .object({
      is: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
      isNot: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
    })
    .strict();

export const IdentitiesOnDeviceDeviceIdIdentityIdCompoundUniqueInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceDeviceIdIdentityIdCompoundUniqueInput> =
  z
    .object({
      deviceId: z.string(),
      identityId: z.string(),
    })
    .strict();

export const IdentitiesOnDeviceCountOrderByAggregateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCountOrderByAggregateInput> =
  z
    .object({
      deviceId: z.lazy(() => SortOrderSchema).optional(),
      identityId: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const IdentitiesOnDeviceMaxOrderByAggregateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceMaxOrderByAggregateInput> =
  z
    .object({
      deviceId: z.lazy(() => SortOrderSchema).optional(),
      identityId: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const IdentitiesOnDeviceMinOrderByAggregateInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceMinOrderByAggregateInput> =
  z
    .object({
      deviceId: z.lazy(() => SortOrderSchema).optional(),
      identityId: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const ProfileCountOrderByAggregateInputSchema: z.ZodType<Prisma.ProfileCountOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      username: z.lazy(() => SortOrderSchema).optional(),
      description: z.lazy(() => SortOrderSchema).optional(),
      avatar: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const ProfileMaxOrderByAggregateInputSchema: z.ZodType<Prisma.ProfileMaxOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      username: z.lazy(() => SortOrderSchema).optional(),
      description: z.lazy(() => SortOrderSchema).optional(),
      avatar: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const ProfileMinOrderByAggregateInputSchema: z.ZodType<Prisma.ProfileMinOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      name: z.lazy(() => SortOrderSchema).optional(),
      username: z.lazy(() => SortOrderSchema).optional(),
      description: z.lazy(() => SortOrderSchema).optional(),
      avatar: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const BoolFilterSchema: z.ZodType<Prisma.BoolFilter> = z
  .object({
    equals: z.boolean().optional(),
    not: z
      .union([z.boolean(), z.lazy(() => NestedBoolFilterSchema)])
      .optional(),
  })
  .strict();

export const DateTimeNullableFilterSchema: z.ZodType<Prisma.DateTimeNullableFilter> =
  z
    .object({
      equals: z.coerce.date().optional().nullable(),
      in: z.coerce.date().array().optional().nullable(),
      notIn: z.coerce.date().array().optional().nullable(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([
          z.coerce.date(),
          z.lazy(() => NestedDateTimeNullableFilterSchema),
        ])
        .optional()
        .nullable(),
    })
    .strict();

export const ConversationMetadataDeviceIdentityIdConversationIdCompoundUniqueInputSchema: z.ZodType<Prisma.ConversationMetadataDeviceIdentityIdConversationIdCompoundUniqueInput> =
  z
    .object({
      deviceIdentityId: z.string(),
      conversationId: z.string(),
    })
    .strict();

export const ConversationMetadataCountOrderByAggregateInputSchema: z.ZodType<Prisma.ConversationMetadataCountOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      conversationId: z.lazy(() => SortOrderSchema).optional(),
      pinned: z.lazy(() => SortOrderSchema).optional(),
      unread: z.lazy(() => SortOrderSchema).optional(),
      deleted: z.lazy(() => SortOrderSchema).optional(),
      readUntil: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const ConversationMetadataMaxOrderByAggregateInputSchema: z.ZodType<Prisma.ConversationMetadataMaxOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      conversationId: z.lazy(() => SortOrderSchema).optional(),
      pinned: z.lazy(() => SortOrderSchema).optional(),
      unread: z.lazy(() => SortOrderSchema).optional(),
      deleted: z.lazy(() => SortOrderSchema).optional(),
      readUntil: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const ConversationMetadataMinOrderByAggregateInputSchema: z.ZodType<Prisma.ConversationMetadataMinOrderByAggregateInput> =
  z
    .object({
      id: z.lazy(() => SortOrderSchema).optional(),
      deviceIdentityId: z.lazy(() => SortOrderSchema).optional(),
      conversationId: z.lazy(() => SortOrderSchema).optional(),
      pinned: z.lazy(() => SortOrderSchema).optional(),
      unread: z.lazy(() => SortOrderSchema).optional(),
      deleted: z.lazy(() => SortOrderSchema).optional(),
      readUntil: z.lazy(() => SortOrderSchema).optional(),
      createdAt: z.lazy(() => SortOrderSchema).optional(),
      updatedAt: z.lazy(() => SortOrderSchema).optional(),
    })
    .strict();

export const BoolWithAggregatesFilterSchema: z.ZodType<Prisma.BoolWithAggregatesFilter> =
  z
    .object({
      equals: z.boolean().optional(),
      not: z
        .union([
          z.boolean(),
          z.lazy(() => NestedBoolWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedBoolFilterSchema).optional(),
      _max: z.lazy(() => NestedBoolFilterSchema).optional(),
    })
    .strict();

export const DateTimeNullableWithAggregatesFilterSchema: z.ZodType<Prisma.DateTimeNullableWithAggregatesFilter> =
  z
    .object({
      equals: z.coerce.date().optional().nullable(),
      in: z.coerce.date().array().optional().nullable(),
      notIn: z.coerce.date().array().optional().nullable(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([
          z.coerce.date(),
          z.lazy(() => NestedDateTimeNullableWithAggregatesFilterSchema),
        ])
        .optional()
        .nullable(),
      _count: z.lazy(() => NestedIntNullableFilterSchema).optional(),
      _min: z.lazy(() => NestedDateTimeNullableFilterSchema).optional(),
      _max: z.lazy(() => NestedDateTimeNullableFilterSchema).optional(),
    })
    .strict();

export const DeviceCreateNestedManyWithoutUserInputSchema: z.ZodType<Prisma.DeviceCreateNestedManyWithoutUserInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceCreateWithoutUserInputSchema),
          z.lazy(() => DeviceCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema).array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema),
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema).array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceCreateManyUserInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateNestedManyWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityCreateNestedManyWithoutUserInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema),
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceIdentityCreateManyUserInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceUncheckedCreateNestedManyWithoutUserInputSchema: z.ZodType<Prisma.DeviceUncheckedCreateNestedManyWithoutUserInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceCreateWithoutUserInputSchema),
          z.lazy(() => DeviceCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema).array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema),
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema).array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceCreateManyUserInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedCreateNestedManyWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedCreateNestedManyWithoutUserInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema),
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceIdentityCreateManyUserInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const StringFieldUpdateOperationsInputSchema: z.ZodType<Prisma.StringFieldUpdateOperationsInput> =
  z
    .object({
      set: z.string().optional(),
    })
    .strict();

export const DateTimeFieldUpdateOperationsInputSchema: z.ZodType<Prisma.DateTimeFieldUpdateOperationsInput> =
  z
    .object({
      set: z.coerce.date().optional(),
    })
    .strict();

export const DeviceUpdateManyWithoutUserNestedInputSchema: z.ZodType<Prisma.DeviceUpdateManyWithoutUserNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceCreateWithoutUserInputSchema),
          z.lazy(() => DeviceCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema).array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema),
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema).array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(() => DeviceUpsertWithWhereUniqueWithoutUserInputSchema),
          z
            .lazy(() => DeviceUpsertWithWhereUniqueWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceCreateManyUserInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(() => DeviceUpdateWithWhereUniqueWithoutUserInputSchema),
          z
            .lazy(() => DeviceUpdateWithWhereUniqueWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(() => DeviceUpdateManyWithWhereWithoutUserInputSchema),
          z.lazy(() => DeviceUpdateManyWithWhereWithoutUserInputSchema).array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => DeviceScalarWhereInputSchema),
          z.lazy(() => DeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUpdateManyWithoutUserNestedInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateManyWithoutUserNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema),
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () => DeviceIdentityUpsertWithWhereUniqueWithoutUserInputSchema,
          ),
          z
            .lazy(
              () => DeviceIdentityUpsertWithWhereUniqueWithoutUserInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceIdentityCreateManyUserInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () => DeviceIdentityUpdateWithWhereUniqueWithoutUserInputSchema,
          ),
          z
            .lazy(
              () => DeviceIdentityUpdateWithWhereUniqueWithoutUserInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(() => DeviceIdentityUpdateManyWithWhereWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityUpdateManyWithWhereWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => DeviceIdentityScalarWhereInputSchema),
          z.lazy(() => DeviceIdentityScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceUncheckedUpdateManyWithoutUserNestedInputSchema: z.ZodType<Prisma.DeviceUncheckedUpdateManyWithoutUserNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceCreateWithoutUserInputSchema),
          z.lazy(() => DeviceCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema),
          z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema).array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema),
          z.lazy(() => DeviceCreateOrConnectWithoutUserInputSchema).array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(() => DeviceUpsertWithWhereUniqueWithoutUserInputSchema),
          z
            .lazy(() => DeviceUpsertWithWhereUniqueWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceCreateManyUserInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceWhereUniqueInputSchema),
          z.lazy(() => DeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(() => DeviceUpdateWithWhereUniqueWithoutUserInputSchema),
          z
            .lazy(() => DeviceUpdateWithWhereUniqueWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(() => DeviceUpdateManyWithWhereWithoutUserInputSchema),
          z.lazy(() => DeviceUpdateManyWithWhereWithoutUserInputSchema).array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => DeviceScalarWhereInputSchema),
          z.lazy(() => DeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateManyWithoutUserNestedInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateManyWithoutUserNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema),
          z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema).array(),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityCreateOrConnectWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () => DeviceIdentityUpsertWithWhereUniqueWithoutUserInputSchema,
          ),
          z
            .lazy(
              () => DeviceIdentityUpsertWithWhereUniqueWithoutUserInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => DeviceIdentityCreateManyUserInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
          z.lazy(() => DeviceIdentityWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () => DeviceIdentityUpdateWithWhereUniqueWithoutUserInputSchema,
          ),
          z
            .lazy(
              () => DeviceIdentityUpdateWithWhereUniqueWithoutUserInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(() => DeviceIdentityUpdateManyWithWhereWithoutUserInputSchema),
          z
            .lazy(() => DeviceIdentityUpdateManyWithWhereWithoutUserInputSchema)
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => DeviceIdentityScalarWhereInputSchema),
          z.lazy(() => DeviceIdentityScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const UserCreateNestedOneWithoutDevicesInputSchema: z.ZodType<Prisma.UserCreateNestedOneWithoutDevicesInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => UserCreateWithoutDevicesInputSchema),
          z.lazy(() => UserUncheckedCreateWithoutDevicesInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => UserCreateOrConnectWithoutDevicesInputSchema)
        .optional(),
      connect: z.lazy(() => UserWhereUniqueInputSchema).optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateNestedManyWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateNestedManyWithoutDeviceInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyDeviceInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedCreateNestedManyWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedCreateNestedManyWithoutDeviceInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyDeviceInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const NullableStringFieldUpdateOperationsInputSchema: z.ZodType<Prisma.NullableStringFieldUpdateOperationsInput> =
  z
    .object({
      set: z.string().optional().nullable(),
    })
    .strict();

export const EnumDeviceOSFieldUpdateOperationsInputSchema: z.ZodType<Prisma.EnumDeviceOSFieldUpdateOperationsInput> =
  z
    .object({
      set: z.lazy(() => DeviceOSSchema).optional(),
    })
    .strict();

export const UserUpdateOneRequiredWithoutDevicesNestedInputSchema: z.ZodType<Prisma.UserUpdateOneRequiredWithoutDevicesNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => UserCreateWithoutDevicesInputSchema),
          z.lazy(() => UserUncheckedCreateWithoutDevicesInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => UserCreateOrConnectWithoutDevicesInputSchema)
        .optional(),
      upsert: z.lazy(() => UserUpsertWithoutDevicesInputSchema).optional(),
      connect: z.lazy(() => UserWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(() => UserUpdateToOneWithWhereWithoutDevicesInputSchema),
          z.lazy(() => UserUpdateWithoutDevicesInputSchema),
          z.lazy(() => UserUncheckedUpdateWithoutDevicesInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyWithoutDeviceNestedInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyWithoutDeviceNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpsertWithWhereUniqueWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpsertWithWhereUniqueWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyDeviceInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpdateWithWhereUniqueWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateWithWhereUniqueWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceUpdateManyWithWhereWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateManyWithWhereWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceNestedInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpsertWithWhereUniqueWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpsertWithWhereUniqueWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyDeviceInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpdateWithWhereUniqueWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateWithWhereUniqueWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceUpdateManyWithWhereWithoutDeviceInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateManyWithWhereWithoutDeviceInputSchema,
            )
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const ProfileCreateNestedOneWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileCreateNestedOneWithoutDeviceIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => ProfileCreateWithoutDeviceIdentityInputSchema),
          z.lazy(() => ProfileUncheckedCreateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => ProfileCreateOrConnectWithoutDeviceIdentityInputSchema)
        .optional(),
      connect: z.lazy(() => ProfileWhereUniqueInputSchema).optional(),
    })
    .strict();

export const ConversationMetadataCreateNestedManyWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataCreateNestedManyWithoutDeviceIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(
            () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
          z.lazy(
            () =>
              ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(
          () => ConversationMetadataCreateManyDeviceIdentityInputEnvelopeSchema,
        )
        .optional(),
      connect: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateNestedManyWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateNestedManyWithoutIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyIdentityInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const UserCreateNestedOneWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserCreateNestedOneWithoutDeviceIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => UserCreateWithoutDeviceIdentityInputSchema),
          z.lazy(() => UserUncheckedCreateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => UserCreateOrConnectWithoutDeviceIdentityInputSchema)
        .optional(),
      connect: z.lazy(() => UserWhereUniqueInputSchema).optional(),
    })
    .strict();

export const ProfileUncheckedCreateNestedOneWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileUncheckedCreateNestedOneWithoutDeviceIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => ProfileCreateWithoutDeviceIdentityInputSchema),
          z.lazy(() => ProfileUncheckedCreateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => ProfileCreateOrConnectWithoutDeviceIdentityInputSchema)
        .optional(),
      connect: z.lazy(() => ProfileWhereUniqueInputSchema).optional(),
    })
    .strict();

export const ConversationMetadataUncheckedCreateNestedManyWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedCreateNestedManyWithoutDeviceIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(
            () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
          z.lazy(
            () =>
              ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(
          () => ConversationMetadataCreateManyDeviceIdentityInputEnvelopeSchema,
        )
        .optional(),
      connect: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedCreateNestedManyWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedCreateNestedManyWithoutIdentityInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyIdentityInputEnvelopeSchema)
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const ProfileUpdateOneWithoutDeviceIdentityNestedInputSchema: z.ZodType<Prisma.ProfileUpdateOneWithoutDeviceIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => ProfileCreateWithoutDeviceIdentityInputSchema),
          z.lazy(() => ProfileUncheckedCreateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => ProfileCreateOrConnectWithoutDeviceIdentityInputSchema)
        .optional(),
      upsert: z
        .lazy(() => ProfileUpsertWithoutDeviceIdentityInputSchema)
        .optional(),
      disconnect: z
        .union([z.boolean(), z.lazy(() => ProfileWhereInputSchema)])
        .optional(),
      delete: z
        .union([z.boolean(), z.lazy(() => ProfileWhereInputSchema)])
        .optional(),
      connect: z.lazy(() => ProfileWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(
            () => ProfileUpdateToOneWithWhereWithoutDeviceIdentityInputSchema,
          ),
          z.lazy(() => ProfileUpdateWithoutDeviceIdentityInputSchema),
          z.lazy(() => ProfileUncheckedUpdateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataUpdateManyWithoutDeviceIdentityNestedInputSchema: z.ZodType<Prisma.ConversationMetadataUpdateManyWithoutDeviceIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(
            () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
          z.lazy(
            () =>
              ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataUpsertWithWhereUniqueWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUpsertWithWhereUniqueWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(
          () => ConversationMetadataCreateManyDeviceIdentityInputEnvelopeSchema,
        )
        .optional(),
      set: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataUpdateWithWhereUniqueWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUpdateWithWhereUniqueWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataUpdateManyWithWhereWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUpdateManyWithWhereWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => ConversationMetadataScalarWhereInputSchema),
          z.lazy(() => ConversationMetadataScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyWithoutIdentityNestedInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyWithoutIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpsertWithWhereUniqueWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpsertWithWhereUniqueWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyIdentityInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpdateWithWhereUniqueWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateWithWhereUniqueWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpdateManyWithWhereWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateManyWithWhereWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const UserUpdateOneRequiredWithoutDeviceIdentityNestedInputSchema: z.ZodType<Prisma.UserUpdateOneRequiredWithoutDeviceIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => UserCreateWithoutDeviceIdentityInputSchema),
          z.lazy(() => UserUncheckedCreateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => UserCreateOrConnectWithoutDeviceIdentityInputSchema)
        .optional(),
      upsert: z
        .lazy(() => UserUpsertWithoutDeviceIdentityInputSchema)
        .optional(),
      connect: z.lazy(() => UserWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(
            () => UserUpdateToOneWithWhereWithoutDeviceIdentityInputSchema,
          ),
          z.lazy(() => UserUpdateWithoutDeviceIdentityInputSchema),
          z.lazy(() => UserUncheckedUpdateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ProfileUncheckedUpdateOneWithoutDeviceIdentityNestedInputSchema: z.ZodType<Prisma.ProfileUncheckedUpdateOneWithoutDeviceIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => ProfileCreateWithoutDeviceIdentityInputSchema),
          z.lazy(() => ProfileUncheckedCreateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => ProfileCreateOrConnectWithoutDeviceIdentityInputSchema)
        .optional(),
      upsert: z
        .lazy(() => ProfileUpsertWithoutDeviceIdentityInputSchema)
        .optional(),
      disconnect: z
        .union([z.boolean(), z.lazy(() => ProfileWhereInputSchema)])
        .optional(),
      delete: z
        .union([z.boolean(), z.lazy(() => ProfileWhereInputSchema)])
        .optional(),
      connect: z.lazy(() => ProfileWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(
            () => ProfileUpdateToOneWithWhereWithoutDeviceIdentityInputSchema,
          ),
          z.lazy(() => ProfileUpdateWithoutDeviceIdentityInputSchema),
          z.lazy(() => ProfileUncheckedUpdateWithoutDeviceIdentityInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityNestedInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(
            () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
          z.lazy(
            () =>
              ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataUpsertWithWhereUniqueWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUpsertWithWhereUniqueWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(
          () => ConversationMetadataCreateManyDeviceIdentityInputEnvelopeSchema,
        )
        .optional(),
      set: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
          z.lazy(() => ConversationMetadataWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataUpdateWithWhereUniqueWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUpdateWithWhereUniqueWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(
            () =>
              ConversationMetadataUpdateManyWithWhereWithoutDeviceIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                ConversationMetadataUpdateManyWithWhereWithoutDeviceIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => ConversationMetadataScalarWhereInputSchema),
          z.lazy(() => ConversationMetadataScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityNestedInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema),
          z
            .lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema)
            .array(),
          z.lazy(
            () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      connectOrCreate: z
        .union([
          z.lazy(
            () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () => IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      upsert: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpsertWithWhereUniqueWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpsertWithWhereUniqueWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      createMany: z
        .lazy(() => IdentitiesOnDeviceCreateManyIdentityInputEnvelopeSchema)
        .optional(),
      set: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      disconnect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      delete: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      connect: z
        .union([
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
          z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema).array(),
        ])
        .optional(),
      update: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpdateWithWhereUniqueWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateWithWhereUniqueWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      updateMany: z
        .union([
          z.lazy(
            () =>
              IdentitiesOnDeviceUpdateManyWithWhereWithoutIdentityInputSchema,
          ),
          z
            .lazy(
              () =>
                IdentitiesOnDeviceUpdateManyWithWhereWithoutIdentityInputSchema,
            )
            .array(),
        ])
        .optional(),
      deleteMany: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceCreateNestedOneWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceCreateNestedOneWithoutIdentitiesInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceCreateWithoutIdentitiesInputSchema),
          z.lazy(() => DeviceUncheckedCreateWithoutIdentitiesInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => DeviceCreateOrConnectWithoutIdentitiesInputSchema)
        .optional(),
      connect: z.lazy(() => DeviceWhereUniqueInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityCreateNestedOneWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityCreateNestedOneWithoutDevicesInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutDevicesInputSchema),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutDevicesInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => DeviceIdentityCreateOrConnectWithoutDevicesInputSchema)
        .optional(),
      connect: z.lazy(() => DeviceIdentityWhereUniqueInputSchema).optional(),
    })
    .strict();

export const DeviceUpdateOneRequiredWithoutIdentitiesNestedInputSchema: z.ZodType<Prisma.DeviceUpdateOneRequiredWithoutIdentitiesNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceCreateWithoutIdentitiesInputSchema),
          z.lazy(() => DeviceUncheckedCreateWithoutIdentitiesInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => DeviceCreateOrConnectWithoutIdentitiesInputSchema)
        .optional(),
      upsert: z.lazy(() => DeviceUpsertWithoutIdentitiesInputSchema).optional(),
      connect: z.lazy(() => DeviceWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(() => DeviceUpdateToOneWithWhereWithoutIdentitiesInputSchema),
          z.lazy(() => DeviceUpdateWithoutIdentitiesInputSchema),
          z.lazy(() => DeviceUncheckedUpdateWithoutIdentitiesInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUpdateOneRequiredWithoutDevicesNestedInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateOneRequiredWithoutDevicesNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutDevicesInputSchema),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutDevicesInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => DeviceIdentityCreateOrConnectWithoutDevicesInputSchema)
        .optional(),
      upsert: z
        .lazy(() => DeviceIdentityUpsertWithoutDevicesInputSchema)
        .optional(),
      connect: z.lazy(() => DeviceIdentityWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(
            () => DeviceIdentityUpdateToOneWithWhereWithoutDevicesInputSchema,
          ),
          z.lazy(() => DeviceIdentityUpdateWithoutDevicesInputSchema),
          z.lazy(() => DeviceIdentityUncheckedUpdateWithoutDevicesInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateNestedOneWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityCreateNestedOneWithoutProfileInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutProfileInputSchema),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutProfileInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => DeviceIdentityCreateOrConnectWithoutProfileInputSchema)
        .optional(),
      connect: z.lazy(() => DeviceIdentityWhereUniqueInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityUpdateOneRequiredWithoutProfileNestedInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateOneRequiredWithoutProfileNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(() => DeviceIdentityCreateWithoutProfileInputSchema),
          z.lazy(() => DeviceIdentityUncheckedCreateWithoutProfileInputSchema),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(() => DeviceIdentityCreateOrConnectWithoutProfileInputSchema)
        .optional(),
      upsert: z
        .lazy(() => DeviceIdentityUpsertWithoutProfileInputSchema)
        .optional(),
      connect: z.lazy(() => DeviceIdentityWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(
            () => DeviceIdentityUpdateToOneWithWhereWithoutProfileInputSchema,
          ),
          z.lazy(() => DeviceIdentityUpdateWithoutProfileInputSchema),
          z.lazy(() => DeviceIdentityUncheckedUpdateWithoutProfileInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateNestedOneWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityCreateNestedOneWithoutConversationMetadataInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(
            () => DeviceIdentityCreateWithoutConversationMetadataInputSchema,
          ),
          z.lazy(
            () =>
              DeviceIdentityUncheckedCreateWithoutConversationMetadataInputSchema,
          ),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(
          () =>
            DeviceIdentityCreateOrConnectWithoutConversationMetadataInputSchema,
        )
        .optional(),
      connect: z.lazy(() => DeviceIdentityWhereUniqueInputSchema).optional(),
    })
    .strict();

export const BoolFieldUpdateOperationsInputSchema: z.ZodType<Prisma.BoolFieldUpdateOperationsInput> =
  z
    .object({
      set: z.boolean().optional(),
    })
    .strict();

export const NullableDateTimeFieldUpdateOperationsInputSchema: z.ZodType<Prisma.NullableDateTimeFieldUpdateOperationsInput> =
  z
    .object({
      set: z.coerce.date().optional().nullable(),
    })
    .strict();

export const DeviceIdentityUpdateOneRequiredWithoutConversationMetadataNestedInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateOneRequiredWithoutConversationMetadataNestedInput> =
  z
    .object({
      create: z
        .union([
          z.lazy(
            () => DeviceIdentityCreateWithoutConversationMetadataInputSchema,
          ),
          z.lazy(
            () =>
              DeviceIdentityUncheckedCreateWithoutConversationMetadataInputSchema,
          ),
        ])
        .optional(),
      connectOrCreate: z
        .lazy(
          () =>
            DeviceIdentityCreateOrConnectWithoutConversationMetadataInputSchema,
        )
        .optional(),
      upsert: z
        .lazy(() => DeviceIdentityUpsertWithoutConversationMetadataInputSchema)
        .optional(),
      connect: z.lazy(() => DeviceIdentityWhereUniqueInputSchema).optional(),
      update: z
        .union([
          z.lazy(
            () =>
              DeviceIdentityUpdateToOneWithWhereWithoutConversationMetadataInputSchema,
          ),
          z.lazy(
            () => DeviceIdentityUpdateWithoutConversationMetadataInputSchema,
          ),
          z.lazy(
            () =>
              DeviceIdentityUncheckedUpdateWithoutConversationMetadataInputSchema,
          ),
        ])
        .optional(),
    })
    .strict();

export const NestedStringFilterSchema: z.ZodType<Prisma.NestedStringFilter> = z
  .object({
    equals: z.string().optional(),
    in: z.string().array().optional(),
    notIn: z.string().array().optional(),
    lt: z.string().optional(),
    lte: z.string().optional(),
    gt: z.string().optional(),
    gte: z.string().optional(),
    contains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    not: z
      .union([z.string(), z.lazy(() => NestedStringFilterSchema)])
      .optional(),
  })
  .strict();

export const NestedDateTimeFilterSchema: z.ZodType<Prisma.NestedDateTimeFilter> =
  z
    .object({
      equals: z.coerce.date().optional(),
      in: z.coerce.date().array().optional(),
      notIn: z.coerce.date().array().optional(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([z.coerce.date(), z.lazy(() => NestedDateTimeFilterSchema)])
        .optional(),
    })
    .strict();

export const NestedStringWithAggregatesFilterSchema: z.ZodType<Prisma.NestedStringWithAggregatesFilter> =
  z
    .object({
      equals: z.string().optional(),
      in: z.string().array().optional(),
      notIn: z.string().array().optional(),
      lt: z.string().optional(),
      lte: z.string().optional(),
      gt: z.string().optional(),
      gte: z.string().optional(),
      contains: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      not: z
        .union([
          z.string(),
          z.lazy(() => NestedStringWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedStringFilterSchema).optional(),
      _max: z.lazy(() => NestedStringFilterSchema).optional(),
    })
    .strict();

export const NestedIntFilterSchema: z.ZodType<Prisma.NestedIntFilter> = z
  .object({
    equals: z.number().optional(),
    in: z.number().array().optional(),
    notIn: z.number().array().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    not: z.union([z.number(), z.lazy(() => NestedIntFilterSchema)]).optional(),
  })
  .strict();

export const NestedDateTimeWithAggregatesFilterSchema: z.ZodType<Prisma.NestedDateTimeWithAggregatesFilter> =
  z
    .object({
      equals: z.coerce.date().optional(),
      in: z.coerce.date().array().optional(),
      notIn: z.coerce.date().array().optional(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([
          z.coerce.date(),
          z.lazy(() => NestedDateTimeWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedDateTimeFilterSchema).optional(),
      _max: z.lazy(() => NestedDateTimeFilterSchema).optional(),
    })
    .strict();

export const NestedStringNullableFilterSchema: z.ZodType<Prisma.NestedStringNullableFilter> =
  z
    .object({
      equals: z.string().optional().nullable(),
      in: z.string().array().optional().nullable(),
      notIn: z.string().array().optional().nullable(),
      lt: z.string().optional(),
      lte: z.string().optional(),
      gt: z.string().optional(),
      gte: z.string().optional(),
      contains: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      not: z
        .union([z.string(), z.lazy(() => NestedStringNullableFilterSchema)])
        .optional()
        .nullable(),
    })
    .strict();

export const NestedEnumDeviceOSFilterSchema: z.ZodType<Prisma.NestedEnumDeviceOSFilter> =
  z
    .object({
      equals: z.lazy(() => DeviceOSSchema).optional(),
      in: z
        .lazy(() => DeviceOSSchema)
        .array()
        .optional(),
      notIn: z
        .lazy(() => DeviceOSSchema)
        .array()
        .optional(),
      not: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => NestedEnumDeviceOSFilterSchema),
        ])
        .optional(),
    })
    .strict();

export const NestedStringNullableWithAggregatesFilterSchema: z.ZodType<Prisma.NestedStringNullableWithAggregatesFilter> =
  z
    .object({
      equals: z.string().optional().nullable(),
      in: z.string().array().optional().nullable(),
      notIn: z.string().array().optional().nullable(),
      lt: z.string().optional(),
      lte: z.string().optional(),
      gt: z.string().optional(),
      gte: z.string().optional(),
      contains: z.string().optional(),
      startsWith: z.string().optional(),
      endsWith: z.string().optional(),
      not: z
        .union([
          z.string(),
          z.lazy(() => NestedStringNullableWithAggregatesFilterSchema),
        ])
        .optional()
        .nullable(),
      _count: z.lazy(() => NestedIntNullableFilterSchema).optional(),
      _min: z.lazy(() => NestedStringNullableFilterSchema).optional(),
      _max: z.lazy(() => NestedStringNullableFilterSchema).optional(),
    })
    .strict();

export const NestedIntNullableFilterSchema: z.ZodType<Prisma.NestedIntNullableFilter> =
  z
    .object({
      equals: z.number().optional().nullable(),
      in: z.number().array().optional().nullable(),
      notIn: z.number().array().optional().nullable(),
      lt: z.number().optional(),
      lte: z.number().optional(),
      gt: z.number().optional(),
      gte: z.number().optional(),
      not: z
        .union([z.number(), z.lazy(() => NestedIntNullableFilterSchema)])
        .optional()
        .nullable(),
    })
    .strict();

export const NestedEnumDeviceOSWithAggregatesFilterSchema: z.ZodType<Prisma.NestedEnumDeviceOSWithAggregatesFilter> =
  z
    .object({
      equals: z.lazy(() => DeviceOSSchema).optional(),
      in: z
        .lazy(() => DeviceOSSchema)
        .array()
        .optional(),
      notIn: z
        .lazy(() => DeviceOSSchema)
        .array()
        .optional(),
      not: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => NestedEnumDeviceOSWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedEnumDeviceOSFilterSchema).optional(),
      _max: z.lazy(() => NestedEnumDeviceOSFilterSchema).optional(),
    })
    .strict();

export const NestedBoolFilterSchema: z.ZodType<Prisma.NestedBoolFilter> = z
  .object({
    equals: z.boolean().optional(),
    not: z
      .union([z.boolean(), z.lazy(() => NestedBoolFilterSchema)])
      .optional(),
  })
  .strict();

export const NestedDateTimeNullableFilterSchema: z.ZodType<Prisma.NestedDateTimeNullableFilter> =
  z
    .object({
      equals: z.coerce.date().optional().nullable(),
      in: z.coerce.date().array().optional().nullable(),
      notIn: z.coerce.date().array().optional().nullable(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([
          z.coerce.date(),
          z.lazy(() => NestedDateTimeNullableFilterSchema),
        ])
        .optional()
        .nullable(),
    })
    .strict();

export const NestedBoolWithAggregatesFilterSchema: z.ZodType<Prisma.NestedBoolWithAggregatesFilter> =
  z
    .object({
      equals: z.boolean().optional(),
      not: z
        .union([
          z.boolean(),
          z.lazy(() => NestedBoolWithAggregatesFilterSchema),
        ])
        .optional(),
      _count: z.lazy(() => NestedIntFilterSchema).optional(),
      _min: z.lazy(() => NestedBoolFilterSchema).optional(),
      _max: z.lazy(() => NestedBoolFilterSchema).optional(),
    })
    .strict();

export const NestedDateTimeNullableWithAggregatesFilterSchema: z.ZodType<Prisma.NestedDateTimeNullableWithAggregatesFilter> =
  z
    .object({
      equals: z.coerce.date().optional().nullable(),
      in: z.coerce.date().array().optional().nullable(),
      notIn: z.coerce.date().array().optional().nullable(),
      lt: z.coerce.date().optional(),
      lte: z.coerce.date().optional(),
      gt: z.coerce.date().optional(),
      gte: z.coerce.date().optional(),
      not: z
        .union([
          z.coerce.date(),
          z.lazy(() => NestedDateTimeNullableWithAggregatesFilterSchema),
        ])
        .optional()
        .nullable(),
      _count: z.lazy(() => NestedIntNullableFilterSchema).optional(),
      _min: z.lazy(() => NestedDateTimeNullableFilterSchema).optional(),
      _max: z.lazy(() => NestedDateTimeNullableFilterSchema).optional(),
    })
    .strict();

export const DeviceCreateWithoutUserInputSchema: z.ZodType<Prisma.DeviceCreateWithoutUserInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      identities: z
        .lazy(() => IdentitiesOnDeviceCreateNestedManyWithoutDeviceInputSchema)
        .optional(),
    })
    .strict();

export const DeviceUncheckedCreateWithoutUserInputSchema: z.ZodType<Prisma.DeviceUncheckedCreateWithoutUserInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      identities: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedCreateNestedManyWithoutDeviceInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceCreateOrConnectWithoutUserInputSchema: z.ZodType<Prisma.DeviceCreateOrConnectWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => DeviceCreateWithoutUserInputSchema),
        z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceCreateManyUserInputEnvelopeSchema: z.ZodType<Prisma.DeviceCreateManyUserInputEnvelope> =
  z
    .object({
      data: z.union([
        z.lazy(() => DeviceCreateManyUserInputSchema),
        z.lazy(() => DeviceCreateManyUserInputSchema).array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const DeviceIdentityCreateWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityCreateWithoutUserInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(() => ProfileCreateNestedOneWithoutDeviceIdentityInputSchema)
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedCreateWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedCreateWithoutUserInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedCreateNestedOneWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateOrConnectWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityCreateOrConnectWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema),
        z.lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityCreateManyUserInputEnvelopeSchema: z.ZodType<Prisma.DeviceIdentityCreateManyUserInputEnvelope> =
  z
    .object({
      data: z.union([
        z.lazy(() => DeviceIdentityCreateManyUserInputSchema),
        z.lazy(() => DeviceIdentityCreateManyUserInputSchema).array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const DeviceUpsertWithWhereUniqueWithoutUserInputSchema: z.ZodType<Prisma.DeviceUpsertWithWhereUniqueWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceWhereUniqueInputSchema),
      update: z.union([
        z.lazy(() => DeviceUpdateWithoutUserInputSchema),
        z.lazy(() => DeviceUncheckedUpdateWithoutUserInputSchema),
      ]),
      create: z.union([
        z.lazy(() => DeviceCreateWithoutUserInputSchema),
        z.lazy(() => DeviceUncheckedCreateWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceUpdateWithWhereUniqueWithoutUserInputSchema: z.ZodType<Prisma.DeviceUpdateWithWhereUniqueWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceWhereUniqueInputSchema),
      data: z.union([
        z.lazy(() => DeviceUpdateWithoutUserInputSchema),
        z.lazy(() => DeviceUncheckedUpdateWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceUpdateManyWithWhereWithoutUserInputSchema: z.ZodType<Prisma.DeviceUpdateManyWithWhereWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceScalarWhereInputSchema),
      data: z.union([
        z.lazy(() => DeviceUpdateManyMutationInputSchema),
        z.lazy(() => DeviceUncheckedUpdateManyWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceScalarWhereInputSchema: z.ZodType<Prisma.DeviceScalarWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => DeviceScalarWhereInputSchema),
          z.lazy(() => DeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => DeviceScalarWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => DeviceScalarWhereInputSchema),
          z.lazy(() => DeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
      id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
      userId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      name: z
        .union([z.lazy(() => StringNullableFilterSchema), z.string()])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => EnumDeviceOSFilterSchema),
          z.lazy(() => DeviceOSSchema),
        ])
        .optional(),
      pushToken: z
        .union([z.lazy(() => StringNullableFilterSchema), z.string()])
        .optional()
        .nullable(),
      expoToken: z
        .union([z.lazy(() => StringNullableFilterSchema), z.string()])
        .optional()
        .nullable(),
      createdAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      updatedAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
    })
    .strict();

export const DeviceIdentityUpsertWithWhereUniqueWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUpsertWithWhereUniqueWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
      update: z.union([
        z.lazy(() => DeviceIdentityUpdateWithoutUserInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateWithoutUserInputSchema),
      ]),
      create: z.union([
        z.lazy(() => DeviceIdentityCreateWithoutUserInputSchema),
        z.lazy(() => DeviceIdentityUncheckedCreateWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityUpdateWithWhereUniqueWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateWithWhereUniqueWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
      data: z.union([
        z.lazy(() => DeviceIdentityUpdateWithoutUserInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityUpdateManyWithWhereWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateManyWithWhereWithoutUserInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityScalarWhereInputSchema),
      data: z.union([
        z.lazy(() => DeviceIdentityUpdateManyMutationInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateManyWithoutUserInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityScalarWhereInputSchema: z.ZodType<Prisma.DeviceIdentityScalarWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => DeviceIdentityScalarWhereInputSchema),
          z.lazy(() => DeviceIdentityScalarWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => DeviceIdentityScalarWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => DeviceIdentityScalarWhereInputSchema),
          z.lazy(() => DeviceIdentityScalarWhereInputSchema).array(),
        ])
        .optional(),
      id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
      userId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      xmtpId: z
        .union([z.lazy(() => StringNullableFilterSchema), z.string()])
        .optional()
        .nullable(),
      privyAddress: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      createdAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      updatedAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
    })
    .strict();

export const UserCreateWithoutDevicesInputSchema: z.ZodType<Prisma.UserCreateWithoutDevicesInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      privyUserId: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      DeviceIdentity: z
        .lazy(() => DeviceIdentityCreateNestedManyWithoutUserInputSchema)
        .optional(),
    })
    .strict();

export const UserUncheckedCreateWithoutDevicesInputSchema: z.ZodType<Prisma.UserUncheckedCreateWithoutDevicesInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      privyUserId: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      DeviceIdentity: z
        .lazy(
          () => DeviceIdentityUncheckedCreateNestedManyWithoutUserInputSchema,
        )
        .optional(),
    })
    .strict();

export const UserCreateOrConnectWithoutDevicesInputSchema: z.ZodType<Prisma.UserCreateOrConnectWithoutDevicesInput> =
  z
    .object({
      where: z.lazy(() => UserWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => UserCreateWithoutDevicesInputSchema),
        z.lazy(() => UserUncheckedCreateWithoutDevicesInputSchema),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceCreateWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateWithoutDeviceInput> =
  z
    .object({
      identity: z.lazy(
        () => DeviceIdentityCreateNestedOneWithoutDevicesInputSchema,
      ),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedCreateWithoutDeviceInput> =
  z
    .object({
      identityId: z.string(),
    })
    .strict();

export const IdentitiesOnDeviceCreateOrConnectWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateOrConnectWithoutDeviceInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema),
        z.lazy(() => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyDeviceInputEnvelopeSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyDeviceInputEnvelope> =
  z
    .object({
      data: z.union([
        z.lazy(() => IdentitiesOnDeviceCreateManyDeviceInputSchema),
        z.lazy(() => IdentitiesOnDeviceCreateManyDeviceInputSchema).array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const UserUpsertWithoutDevicesInputSchema: z.ZodType<Prisma.UserUpsertWithoutDevicesInput> =
  z
    .object({
      update: z.union([
        z.lazy(() => UserUpdateWithoutDevicesInputSchema),
        z.lazy(() => UserUncheckedUpdateWithoutDevicesInputSchema),
      ]),
      create: z.union([
        z.lazy(() => UserCreateWithoutDevicesInputSchema),
        z.lazy(() => UserUncheckedCreateWithoutDevicesInputSchema),
      ]),
      where: z.lazy(() => UserWhereInputSchema).optional(),
    })
    .strict();

export const UserUpdateToOneWithWhereWithoutDevicesInputSchema: z.ZodType<Prisma.UserUpdateToOneWithWhereWithoutDevicesInput> =
  z
    .object({
      where: z.lazy(() => UserWhereInputSchema).optional(),
      data: z.union([
        z.lazy(() => UserUpdateWithoutDevicesInputSchema),
        z.lazy(() => UserUncheckedUpdateWithoutDevicesInputSchema),
      ]),
    })
    .strict();

export const UserUpdateWithoutDevicesInputSchema: z.ZodType<Prisma.UserUpdateWithoutDevicesInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      DeviceIdentity: z
        .lazy(() => DeviceIdentityUpdateManyWithoutUserNestedInputSchema)
        .optional(),
    })
    .strict();

export const UserUncheckedUpdateWithoutDevicesInputSchema: z.ZodType<Prisma.UserUncheckedUpdateWithoutDevicesInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      DeviceIdentity: z
        .lazy(
          () => DeviceIdentityUncheckedUpdateManyWithoutUserNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUpsertWithWhereUniqueWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpsertWithWhereUniqueWithoutDeviceInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
      update: z.union([
        z.lazy(() => IdentitiesOnDeviceUpdateWithoutDeviceInputSchema),
        z.lazy(() => IdentitiesOnDeviceUncheckedUpdateWithoutDeviceInputSchema),
      ]),
      create: z.union([
        z.lazy(() => IdentitiesOnDeviceCreateWithoutDeviceInputSchema),
        z.lazy(() => IdentitiesOnDeviceUncheckedCreateWithoutDeviceInputSchema),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceUpdateWithWhereUniqueWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateWithWhereUniqueWithoutDeviceInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
      data: z.union([
        z.lazy(() => IdentitiesOnDeviceUpdateWithoutDeviceInputSchema),
        z.lazy(() => IdentitiesOnDeviceUncheckedUpdateWithoutDeviceInputSchema),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyWithWhereWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyWithWhereWithoutDeviceInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
      data: z.union([
        z.lazy(() => IdentitiesOnDeviceUpdateManyMutationInputSchema),
        z.lazy(
          () => IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceInputSchema,
        ),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceScalarWhereInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceScalarWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => IdentitiesOnDeviceScalarWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
          z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema).array(),
        ])
        .optional(),
      deviceId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      identityId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
    })
    .strict();

export const ProfileCreateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileCreateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      name: z.string(),
      username: z.string(),
      description: z.string().optional().nullable(),
      avatar: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ProfileUncheckedCreateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileUncheckedCreateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      name: z.string(),
      username: z.string(),
      description: z.string().optional().nullable(),
      avatar: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ProfileCreateOrConnectWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileCreateOrConnectWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => ProfileWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => ProfileCreateWithoutDeviceIdentityInputSchema),
        z.lazy(() => ProfileUncheckedCreateWithoutDeviceIdentityInputSchema),
      ]),
    })
    .strict();

export const ConversationMetadataCreateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataCreateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      conversationId: z.string(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.coerce.date().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedCreateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      conversationId: z.string(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.coerce.date().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const ConversationMetadataCreateOrConnectWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataCreateOrConnectWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
      create: z.union([
        z.lazy(
          () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
        ),
        z.lazy(
          () =>
            ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const ConversationMetadataCreateManyDeviceIdentityInputEnvelopeSchema: z.ZodType<Prisma.ConversationMetadataCreateManyDeviceIdentityInputEnvelope> =
  z
    .object({
      data: z.union([
        z.lazy(() => ConversationMetadataCreateManyDeviceIdentityInputSchema),
        z
          .lazy(() => ConversationMetadataCreateManyDeviceIdentityInputSchema)
          .array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateWithoutIdentityInput> =
  z
    .object({
      device: z.lazy(() => DeviceCreateNestedOneWithoutIdentitiesInputSchema),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedCreateWithoutIdentityInput> =
  z
    .object({
      deviceId: z.string(),
    })
    .strict();

export const IdentitiesOnDeviceCreateOrConnectWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateOrConnectWithoutIdentityInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema),
        z.lazy(
          () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyIdentityInputEnvelopeSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyIdentityInputEnvelope> =
  z
    .object({
      data: z.union([
        z.lazy(() => IdentitiesOnDeviceCreateManyIdentityInputSchema),
        z.lazy(() => IdentitiesOnDeviceCreateManyIdentityInputSchema).array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const UserCreateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserCreateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      privyUserId: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      devices: z
        .lazy(() => DeviceCreateNestedManyWithoutUserInputSchema)
        .optional(),
    })
    .strict();

export const UserUncheckedCreateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserUncheckedCreateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      privyUserId: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      devices: z
        .lazy(() => DeviceUncheckedCreateNestedManyWithoutUserInputSchema)
        .optional(),
    })
    .strict();

export const UserCreateOrConnectWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserCreateOrConnectWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => UserWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => UserCreateWithoutDeviceIdentityInputSchema),
        z.lazy(() => UserUncheckedCreateWithoutDeviceIdentityInputSchema),
      ]),
    })
    .strict();

export const ProfileUpsertWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileUpsertWithoutDeviceIdentityInput> =
  z
    .object({
      update: z.union([
        z.lazy(() => ProfileUpdateWithoutDeviceIdentityInputSchema),
        z.lazy(() => ProfileUncheckedUpdateWithoutDeviceIdentityInputSchema),
      ]),
      create: z.union([
        z.lazy(() => ProfileCreateWithoutDeviceIdentityInputSchema),
        z.lazy(() => ProfileUncheckedCreateWithoutDeviceIdentityInputSchema),
      ]),
      where: z.lazy(() => ProfileWhereInputSchema).optional(),
    })
    .strict();

export const ProfileUpdateToOneWithWhereWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileUpdateToOneWithWhereWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => ProfileWhereInputSchema).optional(),
      data: z.union([
        z.lazy(() => ProfileUpdateWithoutDeviceIdentityInputSchema),
        z.lazy(() => ProfileUncheckedUpdateWithoutDeviceIdentityInputSchema),
      ]),
    })
    .strict();

export const ProfileUpdateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileUpdateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      username: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      description: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      avatar: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ProfileUncheckedUpdateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ProfileUncheckedUpdateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      username: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      description: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      avatar: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataUpsertWithWhereUniqueWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUpsertWithWhereUniqueWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
      update: z.union([
        z.lazy(
          () => ConversationMetadataUpdateWithoutDeviceIdentityInputSchema,
        ),
        z.lazy(
          () =>
            ConversationMetadataUncheckedUpdateWithoutDeviceIdentityInputSchema,
        ),
      ]),
      create: z.union([
        z.lazy(
          () => ConversationMetadataCreateWithoutDeviceIdentityInputSchema,
        ),
        z.lazy(
          () =>
            ConversationMetadataUncheckedCreateWithoutDeviceIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const ConversationMetadataUpdateWithWhereUniqueWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUpdateWithWhereUniqueWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => ConversationMetadataWhereUniqueInputSchema),
      data: z.union([
        z.lazy(
          () => ConversationMetadataUpdateWithoutDeviceIdentityInputSchema,
        ),
        z.lazy(
          () =>
            ConversationMetadataUncheckedUpdateWithoutDeviceIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const ConversationMetadataUpdateManyWithWhereWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUpdateManyWithWhereWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => ConversationMetadataScalarWhereInputSchema),
      data: z.union([
        z.lazy(() => ConversationMetadataUpdateManyMutationInputSchema),
        z.lazy(
          () =>
            ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const ConversationMetadataScalarWhereInputSchema: z.ZodType<Prisma.ConversationMetadataScalarWhereInput> =
  z
    .object({
      AND: z
        .union([
          z.lazy(() => ConversationMetadataScalarWhereInputSchema),
          z.lazy(() => ConversationMetadataScalarWhereInputSchema).array(),
        ])
        .optional(),
      OR: z
        .lazy(() => ConversationMetadataScalarWhereInputSchema)
        .array()
        .optional(),
      NOT: z
        .union([
          z.lazy(() => ConversationMetadataScalarWhereInputSchema),
          z.lazy(() => ConversationMetadataScalarWhereInputSchema).array(),
        ])
        .optional(),
      id: z.union([z.lazy(() => StringFilterSchema), z.string()]).optional(),
      deviceIdentityId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      conversationId: z
        .union([z.lazy(() => StringFilterSchema), z.string()])
        .optional(),
      pinned: z.union([z.lazy(() => BoolFilterSchema), z.boolean()]).optional(),
      unread: z.union([z.lazy(() => BoolFilterSchema), z.boolean()]).optional(),
      deleted: z
        .union([z.lazy(() => BoolFilterSchema), z.boolean()])
        .optional(),
      readUntil: z
        .union([z.lazy(() => DateTimeNullableFilterSchema), z.coerce.date()])
        .optional()
        .nullable(),
      createdAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
      updatedAt: z
        .union([z.lazy(() => DateTimeFilterSchema), z.coerce.date()])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUpsertWithWhereUniqueWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpsertWithWhereUniqueWithoutIdentityInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
      update: z.union([
        z.lazy(() => IdentitiesOnDeviceUpdateWithoutIdentityInputSchema),
        z.lazy(
          () => IdentitiesOnDeviceUncheckedUpdateWithoutIdentityInputSchema,
        ),
      ]),
      create: z.union([
        z.lazy(() => IdentitiesOnDeviceCreateWithoutIdentityInputSchema),
        z.lazy(
          () => IdentitiesOnDeviceUncheckedCreateWithoutIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceUpdateWithWhereUniqueWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateWithWhereUniqueWithoutIdentityInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceWhereUniqueInputSchema),
      data: z.union([
        z.lazy(() => IdentitiesOnDeviceUpdateWithoutIdentityInputSchema),
        z.lazy(
          () => IdentitiesOnDeviceUncheckedUpdateWithoutIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyWithWhereWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyWithWhereWithoutIdentityInput> =
  z
    .object({
      where: z.lazy(() => IdentitiesOnDeviceScalarWhereInputSchema),
      data: z.union([
        z.lazy(() => IdentitiesOnDeviceUpdateManyMutationInputSchema),
        z.lazy(
          () => IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityInputSchema,
        ),
      ]),
    })
    .strict();

export const UserUpsertWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserUpsertWithoutDeviceIdentityInput> =
  z
    .object({
      update: z.union([
        z.lazy(() => UserUpdateWithoutDeviceIdentityInputSchema),
        z.lazy(() => UserUncheckedUpdateWithoutDeviceIdentityInputSchema),
      ]),
      create: z.union([
        z.lazy(() => UserCreateWithoutDeviceIdentityInputSchema),
        z.lazy(() => UserUncheckedCreateWithoutDeviceIdentityInputSchema),
      ]),
      where: z.lazy(() => UserWhereInputSchema).optional(),
    })
    .strict();

export const UserUpdateToOneWithWhereWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserUpdateToOneWithWhereWithoutDeviceIdentityInput> =
  z
    .object({
      where: z.lazy(() => UserWhereInputSchema).optional(),
      data: z.union([
        z.lazy(() => UserUpdateWithoutDeviceIdentityInputSchema),
        z.lazy(() => UserUncheckedUpdateWithoutDeviceIdentityInputSchema),
      ]),
    })
    .strict();

export const UserUpdateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserUpdateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      devices: z
        .lazy(() => DeviceUpdateManyWithoutUserNestedInputSchema)
        .optional(),
    })
    .strict();

export const UserUncheckedUpdateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.UserUncheckedUpdateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      privyUserId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      devices: z
        .lazy(() => DeviceUncheckedUpdateManyWithoutUserNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceCreateWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceCreateWithoutIdentitiesInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      user: z.lazy(() => UserCreateNestedOneWithoutDevicesInputSchema),
    })
    .strict();

export const DeviceUncheckedCreateWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceUncheckedCreateWithoutIdentitiesInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const DeviceCreateOrConnectWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceCreateOrConnectWithoutIdentitiesInput> =
  z
    .object({
      where: z.lazy(() => DeviceWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => DeviceCreateWithoutIdentitiesInputSchema),
        z.lazy(() => DeviceUncheckedCreateWithoutIdentitiesInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityCreateWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityCreateWithoutDevicesInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(() => ProfileCreateNestedOneWithoutDeviceIdentityInputSchema)
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      user: z.lazy(() => UserCreateNestedOneWithoutDeviceIdentityInputSchema),
    })
    .strict();

export const DeviceIdentityUncheckedCreateWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedCreateWithoutDevicesInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedCreateNestedOneWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateOrConnectWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityCreateOrConnectWithoutDevicesInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => DeviceIdentityCreateWithoutDevicesInputSchema),
        z.lazy(() => DeviceIdentityUncheckedCreateWithoutDevicesInputSchema),
      ]),
    })
    .strict();

export const DeviceUpsertWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceUpsertWithoutIdentitiesInput> =
  z
    .object({
      update: z.union([
        z.lazy(() => DeviceUpdateWithoutIdentitiesInputSchema),
        z.lazy(() => DeviceUncheckedUpdateWithoutIdentitiesInputSchema),
      ]),
      create: z.union([
        z.lazy(() => DeviceCreateWithoutIdentitiesInputSchema),
        z.lazy(() => DeviceUncheckedCreateWithoutIdentitiesInputSchema),
      ]),
      where: z.lazy(() => DeviceWhereInputSchema).optional(),
    })
    .strict();

export const DeviceUpdateToOneWithWhereWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceUpdateToOneWithWhereWithoutIdentitiesInput> =
  z
    .object({
      where: z.lazy(() => DeviceWhereInputSchema).optional(),
      data: z.union([
        z.lazy(() => DeviceUpdateWithoutIdentitiesInputSchema),
        z.lazy(() => DeviceUncheckedUpdateWithoutIdentitiesInputSchema),
      ]),
    })
    .strict();

export const DeviceUpdateWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceUpdateWithoutIdentitiesInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      user: z
        .lazy(() => UserUpdateOneRequiredWithoutDevicesNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceUncheckedUpdateWithoutIdentitiesInputSchema: z.ZodType<Prisma.DeviceUncheckedUpdateWithoutIdentitiesInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUpsertWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityUpsertWithoutDevicesInput> =
  z
    .object({
      update: z.union([
        z.lazy(() => DeviceIdentityUpdateWithoutDevicesInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateWithoutDevicesInputSchema),
      ]),
      create: z.union([
        z.lazy(() => DeviceIdentityCreateWithoutDevicesInputSchema),
        z.lazy(() => DeviceIdentityUncheckedCreateWithoutDevicesInputSchema),
      ]),
      where: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityUpdateToOneWithWhereWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateToOneWithWhereWithoutDevicesInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
      data: z.union([
        z.lazy(() => DeviceIdentityUpdateWithoutDevicesInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateWithoutDevicesInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityUpdateWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateWithoutDevicesInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(() => ProfileUpdateOneWithoutDeviceIdentityNestedInputSchema)
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      user: z
        .lazy(() => UserUpdateOneRequiredWithoutDeviceIdentityNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateWithoutDevicesInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateWithoutDevicesInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedUpdateOneWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityCreateWithoutProfileInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
      user: z.lazy(() => UserCreateNestedOneWithoutDeviceIdentityInputSchema),
    })
    .strict();

export const DeviceIdentityUncheckedCreateWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedCreateWithoutProfileInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedCreateNestedManyWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateOrConnectWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityCreateOrConnectWithoutProfileInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
      create: z.union([
        z.lazy(() => DeviceIdentityCreateWithoutProfileInputSchema),
        z.lazy(() => DeviceIdentityUncheckedCreateWithoutProfileInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityUpsertWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityUpsertWithoutProfileInput> =
  z
    .object({
      update: z.union([
        z.lazy(() => DeviceIdentityUpdateWithoutProfileInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateWithoutProfileInputSchema),
      ]),
      create: z.union([
        z.lazy(() => DeviceIdentityCreateWithoutProfileInputSchema),
        z.lazy(() => DeviceIdentityUncheckedCreateWithoutProfileInputSchema),
      ]),
      where: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityUpdateToOneWithWhereWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateToOneWithWhereWithoutProfileInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
      data: z.union([
        z.lazy(() => DeviceIdentityUpdateWithoutProfileInputSchema),
        z.lazy(() => DeviceIdentityUncheckedUpdateWithoutProfileInputSchema),
      ]),
    })
    .strict();

export const DeviceIdentityUpdateWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateWithoutProfileInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
      user: z
        .lazy(() => UserUpdateOneRequiredWithoutDeviceIdentityNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateWithoutProfileInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateWithoutProfileInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityCreateWithoutConversationMetadataInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(() => ProfileCreateNestedOneWithoutDeviceIdentityInputSchema)
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
      user: z.lazy(() => UserCreateNestedOneWithoutDeviceIdentityInputSchema),
    })
    .strict();

export const DeviceIdentityUncheckedCreateWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedCreateWithoutConversationMetadataInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      userId: z.string(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedCreateNestedOneWithoutDeviceIdentityInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedCreateNestedManyWithoutIdentityInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityCreateOrConnectWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityCreateOrConnectWithoutConversationMetadataInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereUniqueInputSchema),
      create: z.union([
        z.lazy(
          () => DeviceIdentityCreateWithoutConversationMetadataInputSchema,
        ),
        z.lazy(
          () =>
            DeviceIdentityUncheckedCreateWithoutConversationMetadataInputSchema,
        ),
      ]),
    })
    .strict();

export const DeviceIdentityUpsertWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityUpsertWithoutConversationMetadataInput> =
  z
    .object({
      update: z.union([
        z.lazy(
          () => DeviceIdentityUpdateWithoutConversationMetadataInputSchema,
        ),
        z.lazy(
          () =>
            DeviceIdentityUncheckedUpdateWithoutConversationMetadataInputSchema,
        ),
      ]),
      create: z.union([
        z.lazy(
          () => DeviceIdentityCreateWithoutConversationMetadataInputSchema,
        ),
        z.lazy(
          () =>
            DeviceIdentityUncheckedCreateWithoutConversationMetadataInputSchema,
        ),
      ]),
      where: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
    })
    .strict();

export const DeviceIdentityUpdateToOneWithWhereWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateToOneWithWhereWithoutConversationMetadataInput> =
  z
    .object({
      where: z.lazy(() => DeviceIdentityWhereInputSchema).optional(),
      data: z.union([
        z.lazy(
          () => DeviceIdentityUpdateWithoutConversationMetadataInputSchema,
        ),
        z.lazy(
          () =>
            DeviceIdentityUncheckedUpdateWithoutConversationMetadataInputSchema,
        ),
      ]),
    })
    .strict();

export const DeviceIdentityUpdateWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateWithoutConversationMetadataInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(() => ProfileUpdateOneWithoutDeviceIdentityNestedInputSchema)
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
      user: z
        .lazy(() => UserUpdateOneRequiredWithoutDeviceIdentityNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateWithoutConversationMetadataInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateWithoutConversationMetadataInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      userId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedUpdateOneWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceCreateManyUserInputSchema: z.ZodType<Prisma.DeviceCreateManyUserInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      name: z.string().optional().nullable(),
      os: z.lazy(() => DeviceOSSchema),
      pushToken: z.string().optional().nullable(),
      expoToken: z.string().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const DeviceIdentityCreateManyUserInputSchema: z.ZodType<Prisma.DeviceIdentityCreateManyUserInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      xmtpId: z.string().optional().nullable(),
      privyAddress: z.string(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const DeviceUpdateWithoutUserInputSchema: z.ZodType<Prisma.DeviceUpdateWithoutUserInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      identities: z
        .lazy(() => IdentitiesOnDeviceUpdateManyWithoutDeviceNestedInputSchema)
        .optional(),
    })
    .strict();

export const DeviceUncheckedUpdateWithoutUserInputSchema: z.ZodType<Prisma.DeviceUncheckedUpdateWithoutUserInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      identities: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceUncheckedUpdateManyWithoutUserInputSchema: z.ZodType<Prisma.DeviceUncheckedUpdateManyWithoutUserInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      name: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      os: z
        .union([
          z.lazy(() => DeviceOSSchema),
          z.lazy(() => EnumDeviceOSFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pushToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      expoToken: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityUpdateWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUpdateWithoutUserInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(() => ProfileUpdateOneWithoutDeviceIdentityNestedInputSchema)
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () => IdentitiesOnDeviceUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateWithoutUserInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      profile: z
        .lazy(
          () => ProfileUncheckedUpdateOneWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      conversationMetadata: z
        .lazy(
          () =>
            ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityNestedInputSchema,
        )
        .optional(),
      devices: z
        .lazy(
          () =>
            IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const DeviceIdentityUncheckedUpdateManyWithoutUserInputSchema: z.ZodType<Prisma.DeviceIdentityUncheckedUpdateManyWithoutUserInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      xmtpId: z
        .union([
          z.string(),
          z.lazy(() => NullableStringFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      privyAddress: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyDeviceInput> =
  z
    .object({
      identityId: z.string(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateWithoutDeviceInput> =
  z
    .object({
      identity: z
        .lazy(
          () => DeviceIdentityUpdateOneRequiredWithoutDevicesNestedInputSchema,
        )
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateWithoutDeviceInput> =
  z
    .object({
      identityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateManyWithoutDeviceInput> =
  z
    .object({
      identityId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataCreateManyDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataCreateManyDeviceIdentityInput> =
  z
    .object({
      id: z.string().uuid().optional(),
      conversationId: z.string(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      deleted: z.boolean().optional(),
      readUntil: z.coerce.date().optional().nullable(),
      createdAt: z.coerce.date().optional(),
      updatedAt: z.coerce.date().optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyIdentityInput> =
  z
    .object({
      deviceId: z.string(),
    })
    .strict();

export const ConversationMetadataUpdateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUpdateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataUncheckedUpdateWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedUpdateWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityInputSchema: z.ZodType<Prisma.ConversationMetadataUncheckedUpdateManyWithoutDeviceIdentityInput> =
  z
    .object({
      id: z
        .union([
          z.string().uuid(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      conversationId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      pinned: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      unread: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      deleted: z
        .union([
          z.boolean(),
          z.lazy(() => BoolFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      readUntil: z
        .union([
          z.coerce.date(),
          z.lazy(() => NullableDateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional()
        .nullable(),
      createdAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
      updatedAt: z
        .union([
          z.coerce.date(),
          z.lazy(() => DateTimeFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateWithoutIdentityInput> =
  z
    .object({
      device: z
        .lazy(() => DeviceUpdateOneRequiredWithoutIdentitiesNestedInputSchema)
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateWithoutIdentityInput> =
  z
    .object({
      deviceId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityInputSchema: z.ZodType<Prisma.IdentitiesOnDeviceUncheckedUpdateManyWithoutIdentityInput> =
  z
    .object({
      deviceId: z
        .union([
          z.string(),
          z.lazy(() => StringFieldUpdateOperationsInputSchema),
        ])
        .optional(),
    })
    .strict();

/////////////////////////////////////////
// ARGS
/////////////////////////////////////////

export const UserFindFirstArgsSchema: z.ZodType<Prisma.UserFindFirstArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    where: UserWhereInputSchema.optional(),
    orderBy: z
      .union([
        UserOrderByWithRelationInputSchema.array(),
        UserOrderByWithRelationInputSchema,
      ])
      .optional(),
    cursor: UserWhereUniqueInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
    distinct: z
      .union([UserScalarFieldEnumSchema, UserScalarFieldEnumSchema.array()])
      .optional(),
  })
  .strict();

export const UserFindFirstOrThrowArgsSchema: z.ZodType<Prisma.UserFindFirstOrThrowArgs> =
  z
    .object({
      select: UserSelectSchema.optional(),
      include: UserIncludeSchema.optional(),
      where: UserWhereInputSchema.optional(),
      orderBy: z
        .union([
          UserOrderByWithRelationInputSchema.array(),
          UserOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: UserWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([UserScalarFieldEnumSchema, UserScalarFieldEnumSchema.array()])
        .optional(),
    })
    .strict();

export const UserFindManyArgsSchema: z.ZodType<Prisma.UserFindManyArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    where: UserWhereInputSchema.optional(),
    orderBy: z
      .union([
        UserOrderByWithRelationInputSchema.array(),
        UserOrderByWithRelationInputSchema,
      ])
      .optional(),
    cursor: UserWhereUniqueInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
    distinct: z
      .union([UserScalarFieldEnumSchema, UserScalarFieldEnumSchema.array()])
      .optional(),
  })
  .strict();

export const UserAggregateArgsSchema: z.ZodType<Prisma.UserAggregateArgs> = z
  .object({
    where: UserWhereInputSchema.optional(),
    orderBy: z
      .union([
        UserOrderByWithRelationInputSchema.array(),
        UserOrderByWithRelationInputSchema,
      ])
      .optional(),
    cursor: UserWhereUniqueInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
  })
  .strict();

export const UserGroupByArgsSchema: z.ZodType<Prisma.UserGroupByArgs> = z
  .object({
    where: UserWhereInputSchema.optional(),
    orderBy: z
      .union([
        UserOrderByWithAggregationInputSchema.array(),
        UserOrderByWithAggregationInputSchema,
      ])
      .optional(),
    by: UserScalarFieldEnumSchema.array(),
    having: UserScalarWhereWithAggregatesInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
  })
  .strict();

export const UserFindUniqueArgsSchema: z.ZodType<Prisma.UserFindUniqueArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    where: UserWhereUniqueInputSchema,
  })
  .strict();

export const UserFindUniqueOrThrowArgsSchema: z.ZodType<Prisma.UserFindUniqueOrThrowArgs> =
  z
    .object({
      select: UserSelectSchema.optional(),
      include: UserIncludeSchema.optional(),
      where: UserWhereUniqueInputSchema,
    })
    .strict();

export const DeviceFindFirstArgsSchema: z.ZodType<Prisma.DeviceFindFirstArgs> =
  z
    .object({
      select: DeviceSelectSchema.optional(),
      include: DeviceIncludeSchema.optional(),
      where: DeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceOrderByWithRelationInputSchema.array(),
          DeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          DeviceScalarFieldEnumSchema,
          DeviceScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceFindFirstOrThrowArgsSchema: z.ZodType<Prisma.DeviceFindFirstOrThrowArgs> =
  z
    .object({
      select: DeviceSelectSchema.optional(),
      include: DeviceIncludeSchema.optional(),
      where: DeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceOrderByWithRelationInputSchema.array(),
          DeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          DeviceScalarFieldEnumSchema,
          DeviceScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceFindManyArgsSchema: z.ZodType<Prisma.DeviceFindManyArgs> = z
  .object({
    select: DeviceSelectSchema.optional(),
    include: DeviceIncludeSchema.optional(),
    where: DeviceWhereInputSchema.optional(),
    orderBy: z
      .union([
        DeviceOrderByWithRelationInputSchema.array(),
        DeviceOrderByWithRelationInputSchema,
      ])
      .optional(),
    cursor: DeviceWhereUniqueInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
    distinct: z
      .union([DeviceScalarFieldEnumSchema, DeviceScalarFieldEnumSchema.array()])
      .optional(),
  })
  .strict();

export const DeviceAggregateArgsSchema: z.ZodType<Prisma.DeviceAggregateArgs> =
  z
    .object({
      where: DeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceOrderByWithRelationInputSchema.array(),
          DeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const DeviceGroupByArgsSchema: z.ZodType<Prisma.DeviceGroupByArgs> = z
  .object({
    where: DeviceWhereInputSchema.optional(),
    orderBy: z
      .union([
        DeviceOrderByWithAggregationInputSchema.array(),
        DeviceOrderByWithAggregationInputSchema,
      ])
      .optional(),
    by: DeviceScalarFieldEnumSchema.array(),
    having: DeviceScalarWhereWithAggregatesInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
  })
  .strict();

export const DeviceFindUniqueArgsSchema: z.ZodType<Prisma.DeviceFindUniqueArgs> =
  z
    .object({
      select: DeviceSelectSchema.optional(),
      include: DeviceIncludeSchema.optional(),
      where: DeviceWhereUniqueInputSchema,
    })
    .strict();

export const DeviceFindUniqueOrThrowArgsSchema: z.ZodType<Prisma.DeviceFindUniqueOrThrowArgs> =
  z
    .object({
      select: DeviceSelectSchema.optional(),
      include: DeviceIncludeSchema.optional(),
      where: DeviceWhereUniqueInputSchema,
    })
    .strict();

export const DeviceIdentityFindFirstArgsSchema: z.ZodType<Prisma.DeviceIdentityFindFirstArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceIdentityOrderByWithRelationInputSchema.array(),
          DeviceIdentityOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceIdentityWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          DeviceIdentityScalarFieldEnumSchema,
          DeviceIdentityScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityFindFirstOrThrowArgsSchema: z.ZodType<Prisma.DeviceIdentityFindFirstOrThrowArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceIdentityOrderByWithRelationInputSchema.array(),
          DeviceIdentityOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceIdentityWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          DeviceIdentityScalarFieldEnumSchema,
          DeviceIdentityScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityFindManyArgsSchema: z.ZodType<Prisma.DeviceIdentityFindManyArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceIdentityOrderByWithRelationInputSchema.array(),
          DeviceIdentityOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceIdentityWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          DeviceIdentityScalarFieldEnumSchema,
          DeviceIdentityScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const DeviceIdentityAggregateArgsSchema: z.ZodType<Prisma.DeviceIdentityAggregateArgs> =
  z
    .object({
      where: DeviceIdentityWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceIdentityOrderByWithRelationInputSchema.array(),
          DeviceIdentityOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: DeviceIdentityWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const DeviceIdentityGroupByArgsSchema: z.ZodType<Prisma.DeviceIdentityGroupByArgs> =
  z
    .object({
      where: DeviceIdentityWhereInputSchema.optional(),
      orderBy: z
        .union([
          DeviceIdentityOrderByWithAggregationInputSchema.array(),
          DeviceIdentityOrderByWithAggregationInputSchema,
        ])
        .optional(),
      by: DeviceIdentityScalarFieldEnumSchema.array(),
      having: DeviceIdentityScalarWhereWithAggregatesInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const DeviceIdentityFindUniqueArgsSchema: z.ZodType<Prisma.DeviceIdentityFindUniqueArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereUniqueInputSchema,
    })
    .strict();

export const DeviceIdentityFindUniqueOrThrowArgsSchema: z.ZodType<Prisma.DeviceIdentityFindUniqueOrThrowArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereUniqueInputSchema,
    })
    .strict();

export const IdentitiesOnDeviceFindFirstArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceFindFirstArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          IdentitiesOnDeviceOrderByWithRelationInputSchema.array(),
          IdentitiesOnDeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: IdentitiesOnDeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          IdentitiesOnDeviceScalarFieldEnumSchema,
          IdentitiesOnDeviceScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceFindFirstOrThrowArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceFindFirstOrThrowArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          IdentitiesOnDeviceOrderByWithRelationInputSchema.array(),
          IdentitiesOnDeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: IdentitiesOnDeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          IdentitiesOnDeviceScalarFieldEnumSchema,
          IdentitiesOnDeviceScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceFindManyArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceFindManyArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          IdentitiesOnDeviceOrderByWithRelationInputSchema.array(),
          IdentitiesOnDeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: IdentitiesOnDeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          IdentitiesOnDeviceScalarFieldEnumSchema,
          IdentitiesOnDeviceScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const IdentitiesOnDeviceAggregateArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceAggregateArgs> =
  z
    .object({
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          IdentitiesOnDeviceOrderByWithRelationInputSchema.array(),
          IdentitiesOnDeviceOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: IdentitiesOnDeviceWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const IdentitiesOnDeviceGroupByArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceGroupByArgs> =
  z
    .object({
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      orderBy: z
        .union([
          IdentitiesOnDeviceOrderByWithAggregationInputSchema.array(),
          IdentitiesOnDeviceOrderByWithAggregationInputSchema,
        ])
        .optional(),
      by: IdentitiesOnDeviceScalarFieldEnumSchema.array(),
      having: IdentitiesOnDeviceScalarWhereWithAggregatesInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const IdentitiesOnDeviceFindUniqueArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceFindUniqueArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereUniqueInputSchema,
    })
    .strict();

export const IdentitiesOnDeviceFindUniqueOrThrowArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceFindUniqueOrThrowArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereUniqueInputSchema,
    })
    .strict();

export const ProfileFindFirstArgsSchema: z.ZodType<Prisma.ProfileFindFirstArgs> =
  z
    .object({
      select: ProfileSelectSchema.optional(),
      include: ProfileIncludeSchema.optional(),
      where: ProfileWhereInputSchema.optional(),
      orderBy: z
        .union([
          ProfileOrderByWithRelationInputSchema.array(),
          ProfileOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ProfileWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          ProfileScalarFieldEnumSchema,
          ProfileScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const ProfileFindFirstOrThrowArgsSchema: z.ZodType<Prisma.ProfileFindFirstOrThrowArgs> =
  z
    .object({
      select: ProfileSelectSchema.optional(),
      include: ProfileIncludeSchema.optional(),
      where: ProfileWhereInputSchema.optional(),
      orderBy: z
        .union([
          ProfileOrderByWithRelationInputSchema.array(),
          ProfileOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ProfileWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          ProfileScalarFieldEnumSchema,
          ProfileScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const ProfileFindManyArgsSchema: z.ZodType<Prisma.ProfileFindManyArgs> =
  z
    .object({
      select: ProfileSelectSchema.optional(),
      include: ProfileIncludeSchema.optional(),
      where: ProfileWhereInputSchema.optional(),
      orderBy: z
        .union([
          ProfileOrderByWithRelationInputSchema.array(),
          ProfileOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ProfileWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          ProfileScalarFieldEnumSchema,
          ProfileScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const ProfileAggregateArgsSchema: z.ZodType<Prisma.ProfileAggregateArgs> =
  z
    .object({
      where: ProfileWhereInputSchema.optional(),
      orderBy: z
        .union([
          ProfileOrderByWithRelationInputSchema.array(),
          ProfileOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ProfileWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const ProfileGroupByArgsSchema: z.ZodType<Prisma.ProfileGroupByArgs> = z
  .object({
    where: ProfileWhereInputSchema.optional(),
    orderBy: z
      .union([
        ProfileOrderByWithAggregationInputSchema.array(),
        ProfileOrderByWithAggregationInputSchema,
      ])
      .optional(),
    by: ProfileScalarFieldEnumSchema.array(),
    having: ProfileScalarWhereWithAggregatesInputSchema.optional(),
    take: z.number().optional(),
    skip: z.number().optional(),
  })
  .strict();

export const ProfileFindUniqueArgsSchema: z.ZodType<Prisma.ProfileFindUniqueArgs> =
  z
    .object({
      select: ProfileSelectSchema.optional(),
      include: ProfileIncludeSchema.optional(),
      where: ProfileWhereUniqueInputSchema,
    })
    .strict();

export const ProfileFindUniqueOrThrowArgsSchema: z.ZodType<Prisma.ProfileFindUniqueOrThrowArgs> =
  z
    .object({
      select: ProfileSelectSchema.optional(),
      include: ProfileIncludeSchema.optional(),
      where: ProfileWhereUniqueInputSchema,
    })
    .strict();

export const ConversationMetadataFindFirstArgsSchema: z.ZodType<Prisma.ConversationMetadataFindFirstArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereInputSchema.optional(),
      orderBy: z
        .union([
          ConversationMetadataOrderByWithRelationInputSchema.array(),
          ConversationMetadataOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ConversationMetadataWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          ConversationMetadataScalarFieldEnumSchema,
          ConversationMetadataScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataFindFirstOrThrowArgsSchema: z.ZodType<Prisma.ConversationMetadataFindFirstOrThrowArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereInputSchema.optional(),
      orderBy: z
        .union([
          ConversationMetadataOrderByWithRelationInputSchema.array(),
          ConversationMetadataOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ConversationMetadataWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          ConversationMetadataScalarFieldEnumSchema,
          ConversationMetadataScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataFindManyArgsSchema: z.ZodType<Prisma.ConversationMetadataFindManyArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereInputSchema.optional(),
      orderBy: z
        .union([
          ConversationMetadataOrderByWithRelationInputSchema.array(),
          ConversationMetadataOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ConversationMetadataWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
      distinct: z
        .union([
          ConversationMetadataScalarFieldEnumSchema,
          ConversationMetadataScalarFieldEnumSchema.array(),
        ])
        .optional(),
    })
    .strict();

export const ConversationMetadataAggregateArgsSchema: z.ZodType<Prisma.ConversationMetadataAggregateArgs> =
  z
    .object({
      where: ConversationMetadataWhereInputSchema.optional(),
      orderBy: z
        .union([
          ConversationMetadataOrderByWithRelationInputSchema.array(),
          ConversationMetadataOrderByWithRelationInputSchema,
        ])
        .optional(),
      cursor: ConversationMetadataWhereUniqueInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const ConversationMetadataGroupByArgsSchema: z.ZodType<Prisma.ConversationMetadataGroupByArgs> =
  z
    .object({
      where: ConversationMetadataWhereInputSchema.optional(),
      orderBy: z
        .union([
          ConversationMetadataOrderByWithAggregationInputSchema.array(),
          ConversationMetadataOrderByWithAggregationInputSchema,
        ])
        .optional(),
      by: ConversationMetadataScalarFieldEnumSchema.array(),
      having:
        ConversationMetadataScalarWhereWithAggregatesInputSchema.optional(),
      take: z.number().optional(),
      skip: z.number().optional(),
    })
    .strict();

export const ConversationMetadataFindUniqueArgsSchema: z.ZodType<Prisma.ConversationMetadataFindUniqueArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereUniqueInputSchema,
    })
    .strict();

export const ConversationMetadataFindUniqueOrThrowArgsSchema: z.ZodType<Prisma.ConversationMetadataFindUniqueOrThrowArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereUniqueInputSchema,
    })
    .strict();

export const UserCreateArgsSchema: z.ZodType<Prisma.UserCreateArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    data: z.union([UserCreateInputSchema, UserUncheckedCreateInputSchema]),
  })
  .strict();

export const UserUpsertArgsSchema: z.ZodType<Prisma.UserUpsertArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    where: UserWhereUniqueInputSchema,
    create: z.union([UserCreateInputSchema, UserUncheckedCreateInputSchema]),
    update: z.union([UserUpdateInputSchema, UserUncheckedUpdateInputSchema]),
  })
  .strict();

export const UserCreateManyArgsSchema: z.ZodType<Prisma.UserCreateManyArgs> = z
  .object({
    data: z.union([
      UserCreateManyInputSchema,
      UserCreateManyInputSchema.array(),
    ]),
    skipDuplicates: z.boolean().optional(),
  })
  .strict();

export const UserCreateManyAndReturnArgsSchema: z.ZodType<Prisma.UserCreateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        UserCreateManyInputSchema,
        UserCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const UserDeleteArgsSchema: z.ZodType<Prisma.UserDeleteArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    where: UserWhereUniqueInputSchema,
  })
  .strict();

export const UserUpdateArgsSchema: z.ZodType<Prisma.UserUpdateArgs> = z
  .object({
    select: UserSelectSchema.optional(),
    include: UserIncludeSchema.optional(),
    data: z.union([UserUpdateInputSchema, UserUncheckedUpdateInputSchema]),
    where: UserWhereUniqueInputSchema,
  })
  .strict();

export const UserUpdateManyArgsSchema: z.ZodType<Prisma.UserUpdateManyArgs> = z
  .object({
    data: z.union([
      UserUpdateManyMutationInputSchema,
      UserUncheckedUpdateManyInputSchema,
    ]),
    where: UserWhereInputSchema.optional(),
    limit: z.number().optional(),
  })
  .strict();

export const UserUpdateManyAndReturnArgsSchema: z.ZodType<Prisma.UserUpdateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        UserUpdateManyMutationInputSchema,
        UserUncheckedUpdateManyInputSchema,
      ]),
      where: UserWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const UserDeleteManyArgsSchema: z.ZodType<Prisma.UserDeleteManyArgs> = z
  .object({
    where: UserWhereInputSchema.optional(),
    limit: z.number().optional(),
  })
  .strict();

export const DeviceCreateArgsSchema: z.ZodType<Prisma.DeviceCreateArgs> = z
  .object({
    select: DeviceSelectSchema.optional(),
    include: DeviceIncludeSchema.optional(),
    data: z.union([DeviceCreateInputSchema, DeviceUncheckedCreateInputSchema]),
  })
  .strict();

export const DeviceUpsertArgsSchema: z.ZodType<Prisma.DeviceUpsertArgs> = z
  .object({
    select: DeviceSelectSchema.optional(),
    include: DeviceIncludeSchema.optional(),
    where: DeviceWhereUniqueInputSchema,
    create: z.union([
      DeviceCreateInputSchema,
      DeviceUncheckedCreateInputSchema,
    ]),
    update: z.union([
      DeviceUpdateInputSchema,
      DeviceUncheckedUpdateInputSchema,
    ]),
  })
  .strict();

export const DeviceCreateManyArgsSchema: z.ZodType<Prisma.DeviceCreateManyArgs> =
  z
    .object({
      data: z.union([
        DeviceCreateManyInputSchema,
        DeviceCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const DeviceCreateManyAndReturnArgsSchema: z.ZodType<Prisma.DeviceCreateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        DeviceCreateManyInputSchema,
        DeviceCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const DeviceDeleteArgsSchema: z.ZodType<Prisma.DeviceDeleteArgs> = z
  .object({
    select: DeviceSelectSchema.optional(),
    include: DeviceIncludeSchema.optional(),
    where: DeviceWhereUniqueInputSchema,
  })
  .strict();

export const DeviceUpdateArgsSchema: z.ZodType<Prisma.DeviceUpdateArgs> = z
  .object({
    select: DeviceSelectSchema.optional(),
    include: DeviceIncludeSchema.optional(),
    data: z.union([DeviceUpdateInputSchema, DeviceUncheckedUpdateInputSchema]),
    where: DeviceWhereUniqueInputSchema,
  })
  .strict();

export const DeviceUpdateManyArgsSchema: z.ZodType<Prisma.DeviceUpdateManyArgs> =
  z
    .object({
      data: z.union([
        DeviceUpdateManyMutationInputSchema,
        DeviceUncheckedUpdateManyInputSchema,
      ]),
      where: DeviceWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const DeviceUpdateManyAndReturnArgsSchema: z.ZodType<Prisma.DeviceUpdateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        DeviceUpdateManyMutationInputSchema,
        DeviceUncheckedUpdateManyInputSchema,
      ]),
      where: DeviceWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const DeviceDeleteManyArgsSchema: z.ZodType<Prisma.DeviceDeleteManyArgs> =
  z
    .object({
      where: DeviceWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const DeviceIdentityCreateArgsSchema: z.ZodType<Prisma.DeviceIdentityCreateArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      data: z.union([
        DeviceIdentityCreateInputSchema,
        DeviceIdentityUncheckedCreateInputSchema,
      ]),
    })
    .strict();

export const DeviceIdentityUpsertArgsSchema: z.ZodType<Prisma.DeviceIdentityUpsertArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereUniqueInputSchema,
      create: z.union([
        DeviceIdentityCreateInputSchema,
        DeviceIdentityUncheckedCreateInputSchema,
      ]),
      update: z.union([
        DeviceIdentityUpdateInputSchema,
        DeviceIdentityUncheckedUpdateInputSchema,
      ]),
    })
    .strict();

export const DeviceIdentityCreateManyArgsSchema: z.ZodType<Prisma.DeviceIdentityCreateManyArgs> =
  z
    .object({
      data: z.union([
        DeviceIdentityCreateManyInputSchema,
        DeviceIdentityCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const DeviceIdentityCreateManyAndReturnArgsSchema: z.ZodType<Prisma.DeviceIdentityCreateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        DeviceIdentityCreateManyInputSchema,
        DeviceIdentityCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const DeviceIdentityDeleteArgsSchema: z.ZodType<Prisma.DeviceIdentityDeleteArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      where: DeviceIdentityWhereUniqueInputSchema,
    })
    .strict();

export const DeviceIdentityUpdateArgsSchema: z.ZodType<Prisma.DeviceIdentityUpdateArgs> =
  z
    .object({
      select: DeviceIdentitySelectSchema.optional(),
      include: DeviceIdentityIncludeSchema.optional(),
      data: z.union([
        DeviceIdentityUpdateInputSchema,
        DeviceIdentityUncheckedUpdateInputSchema,
      ]),
      where: DeviceIdentityWhereUniqueInputSchema,
    })
    .strict();

export const DeviceIdentityUpdateManyArgsSchema: z.ZodType<Prisma.DeviceIdentityUpdateManyArgs> =
  z
    .object({
      data: z.union([
        DeviceIdentityUpdateManyMutationInputSchema,
        DeviceIdentityUncheckedUpdateManyInputSchema,
      ]),
      where: DeviceIdentityWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const DeviceIdentityUpdateManyAndReturnArgsSchema: z.ZodType<Prisma.DeviceIdentityUpdateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        DeviceIdentityUpdateManyMutationInputSchema,
        DeviceIdentityUncheckedUpdateManyInputSchema,
      ]),
      where: DeviceIdentityWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const DeviceIdentityDeleteManyArgsSchema: z.ZodType<Prisma.DeviceIdentityDeleteManyArgs> =
  z
    .object({
      where: DeviceIdentityWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      data: z.union([
        IdentitiesOnDeviceCreateInputSchema,
        IdentitiesOnDeviceUncheckedCreateInputSchema,
      ]),
    })
    .strict();

export const IdentitiesOnDeviceUpsertArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpsertArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereUniqueInputSchema,
      create: z.union([
        IdentitiesOnDeviceCreateInputSchema,
        IdentitiesOnDeviceUncheckedCreateInputSchema,
      ]),
      update: z.union([
        IdentitiesOnDeviceUpdateInputSchema,
        IdentitiesOnDeviceUncheckedUpdateInputSchema,
      ]),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyArgs> =
  z
    .object({
      data: z.union([
        IdentitiesOnDeviceCreateManyInputSchema,
        IdentitiesOnDeviceCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const IdentitiesOnDeviceCreateManyAndReturnArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceCreateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        IdentitiesOnDeviceCreateManyInputSchema,
        IdentitiesOnDeviceCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const IdentitiesOnDeviceDeleteArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceDeleteArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      where: IdentitiesOnDeviceWhereUniqueInputSchema,
    })
    .strict();

export const IdentitiesOnDeviceUpdateArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateArgs> =
  z
    .object({
      select: IdentitiesOnDeviceSelectSchema.optional(),
      include: IdentitiesOnDeviceIncludeSchema.optional(),
      data: z.union([
        IdentitiesOnDeviceUpdateInputSchema,
        IdentitiesOnDeviceUncheckedUpdateInputSchema,
      ]),
      where: IdentitiesOnDeviceWhereUniqueInputSchema,
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyArgs> =
  z
    .object({
      data: z.union([
        IdentitiesOnDeviceUpdateManyMutationInputSchema,
        IdentitiesOnDeviceUncheckedUpdateManyInputSchema,
      ]),
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const IdentitiesOnDeviceUpdateManyAndReturnArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceUpdateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        IdentitiesOnDeviceUpdateManyMutationInputSchema,
        IdentitiesOnDeviceUncheckedUpdateManyInputSchema,
      ]),
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const IdentitiesOnDeviceDeleteManyArgsSchema: z.ZodType<Prisma.IdentitiesOnDeviceDeleteManyArgs> =
  z
    .object({
      where: IdentitiesOnDeviceWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const ProfileCreateArgsSchema: z.ZodType<Prisma.ProfileCreateArgs> = z
  .object({
    select: ProfileSelectSchema.optional(),
    include: ProfileIncludeSchema.optional(),
    data: z.union([
      ProfileCreateInputSchema,
      ProfileUncheckedCreateInputSchema,
    ]),
  })
  .strict();

export const ProfileUpsertArgsSchema: z.ZodType<Prisma.ProfileUpsertArgs> = z
  .object({
    select: ProfileSelectSchema.optional(),
    include: ProfileIncludeSchema.optional(),
    where: ProfileWhereUniqueInputSchema,
    create: z.union([
      ProfileCreateInputSchema,
      ProfileUncheckedCreateInputSchema,
    ]),
    update: z.union([
      ProfileUpdateInputSchema,
      ProfileUncheckedUpdateInputSchema,
    ]),
  })
  .strict();

export const ProfileCreateManyArgsSchema: z.ZodType<Prisma.ProfileCreateManyArgs> =
  z
    .object({
      data: z.union([
        ProfileCreateManyInputSchema,
        ProfileCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const ProfileCreateManyAndReturnArgsSchema: z.ZodType<Prisma.ProfileCreateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        ProfileCreateManyInputSchema,
        ProfileCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const ProfileDeleteArgsSchema: z.ZodType<Prisma.ProfileDeleteArgs> = z
  .object({
    select: ProfileSelectSchema.optional(),
    include: ProfileIncludeSchema.optional(),
    where: ProfileWhereUniqueInputSchema,
  })
  .strict();

export const ProfileUpdateArgsSchema: z.ZodType<Prisma.ProfileUpdateArgs> = z
  .object({
    select: ProfileSelectSchema.optional(),
    include: ProfileIncludeSchema.optional(),
    data: z.union([
      ProfileUpdateInputSchema,
      ProfileUncheckedUpdateInputSchema,
    ]),
    where: ProfileWhereUniqueInputSchema,
  })
  .strict();

export const ProfileUpdateManyArgsSchema: z.ZodType<Prisma.ProfileUpdateManyArgs> =
  z
    .object({
      data: z.union([
        ProfileUpdateManyMutationInputSchema,
        ProfileUncheckedUpdateManyInputSchema,
      ]),
      where: ProfileWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const ProfileUpdateManyAndReturnArgsSchema: z.ZodType<Prisma.ProfileUpdateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        ProfileUpdateManyMutationInputSchema,
        ProfileUncheckedUpdateManyInputSchema,
      ]),
      where: ProfileWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const ProfileDeleteManyArgsSchema: z.ZodType<Prisma.ProfileDeleteManyArgs> =
  z
    .object({
      where: ProfileWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const ConversationMetadataCreateArgsSchema: z.ZodType<Prisma.ConversationMetadataCreateArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      data: z.union([
        ConversationMetadataCreateInputSchema,
        ConversationMetadataUncheckedCreateInputSchema,
      ]),
    })
    .strict();

export const ConversationMetadataUpsertArgsSchema: z.ZodType<Prisma.ConversationMetadataUpsertArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereUniqueInputSchema,
      create: z.union([
        ConversationMetadataCreateInputSchema,
        ConversationMetadataUncheckedCreateInputSchema,
      ]),
      update: z.union([
        ConversationMetadataUpdateInputSchema,
        ConversationMetadataUncheckedUpdateInputSchema,
      ]),
    })
    .strict();

export const ConversationMetadataCreateManyArgsSchema: z.ZodType<Prisma.ConversationMetadataCreateManyArgs> =
  z
    .object({
      data: z.union([
        ConversationMetadataCreateManyInputSchema,
        ConversationMetadataCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const ConversationMetadataCreateManyAndReturnArgsSchema: z.ZodType<Prisma.ConversationMetadataCreateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        ConversationMetadataCreateManyInputSchema,
        ConversationMetadataCreateManyInputSchema.array(),
      ]),
      skipDuplicates: z.boolean().optional(),
    })
    .strict();

export const ConversationMetadataDeleteArgsSchema: z.ZodType<Prisma.ConversationMetadataDeleteArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      where: ConversationMetadataWhereUniqueInputSchema,
    })
    .strict();

export const ConversationMetadataUpdateArgsSchema: z.ZodType<Prisma.ConversationMetadataUpdateArgs> =
  z
    .object({
      select: ConversationMetadataSelectSchema.optional(),
      include: ConversationMetadataIncludeSchema.optional(),
      data: z.union([
        ConversationMetadataUpdateInputSchema,
        ConversationMetadataUncheckedUpdateInputSchema,
      ]),
      where: ConversationMetadataWhereUniqueInputSchema,
    })
    .strict();

export const ConversationMetadataUpdateManyArgsSchema: z.ZodType<Prisma.ConversationMetadataUpdateManyArgs> =
  z
    .object({
      data: z.union([
        ConversationMetadataUpdateManyMutationInputSchema,
        ConversationMetadataUncheckedUpdateManyInputSchema,
      ]),
      where: ConversationMetadataWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const ConversationMetadataUpdateManyAndReturnArgsSchema: z.ZodType<Prisma.ConversationMetadataUpdateManyAndReturnArgs> =
  z
    .object({
      data: z.union([
        ConversationMetadataUpdateManyMutationInputSchema,
        ConversationMetadataUncheckedUpdateManyInputSchema,
      ]),
      where: ConversationMetadataWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();

export const ConversationMetadataDeleteManyArgsSchema: z.ZodType<Prisma.ConversationMetadataDeleteManyArgs> =
  z
    .object({
      where: ConversationMetadataWhereInputSchema.optional(),
      limit: z.number().optional(),
    })
    .strict();
